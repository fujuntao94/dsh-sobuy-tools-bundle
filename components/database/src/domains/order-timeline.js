/**
 * 订单事件时间线（oms_t_order_action 订单改单操作流水）。
 *
 * 这张表是全库唯一能还原"这笔订单经历过什么"的数据源，约 2196 万行，
 * 单笔订单平均 10.9 条流水，但极值可达 10 万条以上，因此 LIMIT 是硬需求。
 *
 * 索引 `idx_order_id_create_time (order_id, create_time)` 实测命中 `ref`，
 * 按单号取最近 N 条稳定在数百毫秒内。
 *
 * 三个必须知道的数据事实：
 * 1. `reason`（原因码）**只在 `operation` 为「拦截」时才非空**（另有极少量
 *    「异常打单-自动拦截」）。它不是"订单原因"，是"拦截原因"。
 * 2. `reason` 是混合编码：G 码能查到字典，数字码与中文码在本库任何字典中都没有，
 *    实测整体翻译命中率约 50.9%。因此必须原样返回未翻译的编码，不能静默留空。
 * 3. `information` 是机器生成的状态文本（"发布成功"、"面单号:xxx"、承运商报错），
 *    抽样未发现客户 PII；`action_explain` 是人工填写的解释，PII 风险最高且覆盖率仅
 *    0.06%，因此**查询里根本不选这一列**。
 */
import { runDatabaseOperation } from './connection.js'
import { formatLocalDateTime } from './format.js'
import { resolveSecurityPolicy } from '../security/policy.js'
import { maskSensitiveRows } from '../security/sensitive-fields.js'
import { DICTIONARY_VALUES_TABLE, REASON_CODE_DICT_ID } from './dictionary.js'

const ACTION_TABLE = 'oms_t_order_action'

/** 时间线要读操作流水，并借字典表翻译原因码，两张表都必须先加入白名单。 */
export const ORDER_TIMELINE_TABLES = Object.freeze([ACTION_TABLE, DICTIONARY_VALUES_TABLE])

export const DEFAULT_TIMELINE_LIMIT = 50
export const MAX_TIMELINE_LIMIT = 200

/** order_id 是 varchar(64)。 */
const MAX_ORDER_ID_LENGTH = 64

/** information 最长的几条是承运商报错 JSON，截断到 300 字符既保留信息量又控制返回体积。 */
const INFORMATION_LIMIT = 300

const ALLOWED_PARAMS = new Set(['order_id', 'limit'])

function positiveInteger(value, label, { minimum, maximum }) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 之间的整数。`)
  }
  return number
}

function toInt(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : 0
}

function toStringValue(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

/** 参数与 SQL 之间唯一的桥：只接受白名单参数，越界直接报错，不做静默兜底。 */
export function normalizeTimelineParams(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('订单时间线参数无效。')
  const unknown = Object.keys(input).filter(key => !ALLOWED_PARAMS.has(key))
  if (unknown.length) throw new Error(`订单时间线不支持参数：${unknown.join('、')}。`)

  if (input.order_id === undefined || input.order_id === null) throw new Error('order_id 不能为空。')
  const orderId = String(input.order_id).trim()
  if (!orderId) throw new Error('order_id 不能为空。')
  if (orderId.length > MAX_ORDER_ID_LENGTH) {
    throw new Error(`order_id 长度不能超过 ${MAX_ORDER_ID_LENGTH} 个字符。`)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f\x7f]/.test(orderId)) throw new Error('order_id 包含无效字符。')

  return {
    order_id: orderId,
    limit: input.limit === undefined || input.limit === null
      ? DEFAULT_TIMELINE_LIMIT
      : positiveInteger(input.limit, 'limit', { minimum: 1, maximum: MAX_TIMELINE_LIMIT }),
  }
}

/** 两张表必须都在白名单内；缺哪张就报哪张，便于直接照做。 */
export function assertTimelineTablesAllowed(config = {}) {
  const { allowedTables } = resolveSecurityPolicy(config)
  const missing = ORDER_TIMELINE_TABLES.filter(table => !allowedTables.includes(table))
  if (missing.length) {
    throw new Error(`订单时间线需要先把以下数据表加入业务表白名单：${missing.join('、')}。请在数据库设置页添加后重试。`)
  }
}

const COUNT_SQL = `
SELECT CAST(COUNT(*) AS SIGNED) AS total
FROM ${ACTION_TABLE}
WHERE order_id = ?`.trim()

/**
 * 生成时间线查询。
 *
 * 原因码用派生表做 LEFT JOIN：先把 dict_id=3 的字典按 dict_value 聚合，
 * 避免字典里出现重复 dict_value 时放大行数（当前实测无重复，但不依赖该现状）。
 */
const TIMELINE_SQL = `
SELECT
  a.logid,
  a.operation,
  a.operation_en,
  a.reason,
  reason_dict.note AS reason_note,
  LEFT(a.information, ${INFORMATION_LIMIT}) AS information,
  a.operators,
  DATE_FORMAT(a.create_time, '%Y-%m-%d %H:%i:%s') AS create_time
FROM ${ACTION_TABLE} a
LEFT JOIN (
  SELECT dict_value, MAX(note) AS note
  FROM ${DICTIONARY_VALUES_TABLE}
  WHERE dict_id = ?
  GROUP BY dict_value
) reason_dict ON reason_dict.dict_value = a.reason
WHERE a.order_id = ?
ORDER BY a.create_time DESC
LIMIT ?`.trim()

export function buildTimelineQuery(input = {}) {
  const params = normalizeTimelineParams(input)
  return {
    countSql: COUNT_SQL,
    countValues: [params.order_id],
    sql: TIMELINE_SQL,
    values: [REASON_CODE_DICT_ID, params.order_id, params.limit],
    meta: { orderId: params.order_id, appliedLimit: params.limit },
  }
}

export function normalizeTimelineEntries(rows) {
  if (!Array.isArray(rows)) return []
  return rows.map(row => {
    const reason = toStringValue(row.reason).trim()
    const reasonNote = toStringValue(row.reason_note).trim()
    return {
      logid: toInt(row.logid),
      operation: toStringValue(row.operation),
      operationEn: toStringValue(row.operation_en),
      reason,
      reasonNote,
      // 未翻译的编码必须显式标出来：reason 是混合编码，数字码和中文码本来就查不到字典。
      reasonTranslated: Boolean(reason) && Boolean(reasonNote),
      information: toStringValue(row.information),
      operators: toStringValue(row.operators),
      createTime: toStringValue(row.create_time),
    }
  })
}

/** 只读执行时间线查询；超时与取消沿用连接层的统一处理。 */
export async function runOrderTimeline(config, input = {}, {
  createConnection,
  signal,
  now = () => new Date(),
} = {}) {
  const params = normalizeTimelineParams(input)
  assertTimelineTablesAllowed(config)
  const built = buildTimelineQuery(params)

  const payload = await runDatabaseOperation(
    config,
    async connection => {
      const [countRows] = await connection.execute(built.countSql, built.countValues)
      const [entries] = await connection.execute(built.sql, built.values)
      return { total: toInt(countRows?.[0]?.total), entries }
    },
    { createConnection, signal, timeoutMs: resolveSecurityPolicy(config).queryTimeoutMs },
  )

  const entries = maskSensitiveRows(normalizeTimelineEntries(payload.entries), config)
  const withReason = entries.filter(entry => entry.reason)
  return {
    orderId: params.order_id,
    totalRecords: payload.total,
    returned: entries.length,
    mayBeTruncated: payload.total > entries.length,
    translatedReasons: withReason.filter(entry => entry.reasonTranslated).length,
    untranslatedReasons: withReason.filter(entry => !entry.reasonTranslated).length,
    entries,
    generatedAt: formatLocalDateTime(now()),
  }
}
