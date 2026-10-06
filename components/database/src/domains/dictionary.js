/**
 * 通用字典查询（bas_t_dict 字典主表 + bas_t_dict_values 字典值表）。
 *
 * 与 safe-select.js 的区别：这里的 SQL 是**代码内固定**的模板，模型只能选参数，
 * 永远接触不到 SQL 字符串或表名，因此不需要开放任意 SQL。
 *
 * `dict_id = 3`（Types Of Complaint）是**订单原因码字典**：订单操作流水
 * `oms_t_order_action.reason` 里的 G 码（G01/G17/G28…）就来自这里。
 * 但要注意 reason 是**混合编码**，只有 G 码能在这张字典里查到；
 * 实测数字码（34/38/40/50…）与中文码（取消订单/其他原因）在本库任何字典中都不存在。
 */
import { runDatabaseOperation } from './connection.js'
import { formatLocalDateTime } from './format.js'
import { resolveSecurityPolicy } from '../security/policy.js'
import { maskSensitiveRows } from '../security/sensitive-fields.js'

const DICTIONARY_TABLE = 'bas_t_dict'
/** 订单时间线要借这张表翻译原因码，因此单独导出。 */
export const DICTIONARY_VALUES_TABLE = 'bas_t_dict_values'

/** 字典查询固定读取的两张只读表。 */
export const DICTIONARY_TABLES = Object.freeze([DICTIONARY_TABLE, DICTIONARY_VALUES_TABLE])

/** dict_id=3 的原因码（G 码）字典，订单操作流水 reason 字段的编码来源。 */
export const REASON_CODE_DICT_ID = 3

/** 整张 bas_t_dict_values 实测仅 305 行，上限设为 500 可保证当前数据永不截断。 */
export const MAX_DICTIONARY_ROWS = 500

/** dict_value 与 note 的列长度都是 50 / 100，这里按更严的 50 收口。 */
const MAX_CODE_LENGTH = 50

const ALLOWED_PARAMS = new Set(['dict_id', 'dict_value', 'keyword', 'include_deprecated'])

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

/** 控制字符会破坏日志与展示，直接在入口拒绝，不做静默清洗。 */
function textFilter(value, label) {
  const text = String(value).trim()
  if (!text) throw new Error(`${label}不能为空。`)
  if (text.length > MAX_CODE_LENGTH) throw new Error(`${label}长度不能超过 ${MAX_CODE_LENGTH} 个字符。`)
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f\x7f]/.test(text)) throw new Error(`${label}包含无效字符。`)
  return text
}

/**
 * LIKE 通配符转义。
 * 参数化查询已经挡住 SQL 注入，但 `%` 与 `_` 作为**语义**通配符仍会放大结果范围，
 * 因此按 MySQL 默认转义符 `\` 显式转义。
 */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

/** 参数与 SQL 之间唯一的桥：只接受白名单参数，越界直接报错，不做静默兜底。 */
export function normalizeDictionaryParams(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('字典查询参数无效。')
  const unknown = Object.keys(input).filter(key => !ALLOWED_PARAMS.has(key))
  if (unknown.length) throw new Error(`字典查询不支持参数：${unknown.join('、')}。`)

  const includeDeprecated = input.include_deprecated === undefined || input.include_deprecated === null
    ? false
    : input.include_deprecated
  if (typeof includeDeprecated !== 'boolean') throw new Error('include_deprecated 必须是布尔值。')

  const dictId = input.dict_id === undefined || input.dict_id === null
    ? null
    : positiveInteger(input.dict_id, 'dict_id', { minimum: 1, maximum: 100000 })

  return {
    dict_id: dictId,
    dict_value: input.dict_value === undefined || input.dict_value === null
      ? null
      : textFilter(input.dict_value, 'dict_value'),
    keyword: input.keyword === undefined || input.keyword === null
      ? null
      : textFilter(input.keyword, 'keyword'),
    include_deprecated: includeDeprecated,
  }
}

/** 未提供任何筛选条件时走"字典目录"模式，用于先看清有哪些字典。 */
export function isDictionaryDiscovery(params) {
  return params.dict_id === null && params.dict_value === null && params.keyword === null
}

const CATALOG_SQL = `
SELECT
  dict_id,
  dict_name,
  valid
FROM ${DICTIONARY_TABLE}
ORDER BY dict_id
LIMIT ${MAX_DICTIONARY_ROWS}`.trim()

/**
 * 生成字典值查询。返回单条 SELECT：只有代码常量与占位符，
 * 没有任何字符串拼接的用户输入（keyword 也只以参数形式传入）。
 */
export function buildDictionaryValuesQuery(input = {}) {
  const params = normalizeDictionaryParams(input)
  const conditions = []
  const values = []

  if (params.dict_id !== null) {
    conditions.push('d.dict_id = ?')
    values.push(params.dict_id)
  }
  if (params.dict_value !== null) {
    conditions.push('d.dict_value = ?')
    values.push(params.dict_value)
  }
  if (params.keyword !== null) {
    const pattern = `%${escapeLike(params.keyword)}%`
    conditions.push('(d.dict_value LIKE ? OR COALESCE(d.note, \'\') LIKE ?)')
    values.push(pattern, pattern)
  }
  // 已失效的字典项默认不返回：它们仍存在于历史数据里，但通常不是当前可选值。
  if (!params.include_deprecated) conditions.push('d.valid = 1')

  const where = conditions.length ? conditions.join('\n    AND ') : '1 = 1'
  const sql = `
SELECT
  d.dict_id,
  n.dict_name,
  d.dict_value,
  d.note,
  d.status,
  d.valid
FROM ${DICTIONARY_VALUES_TABLE} d
LEFT JOIN ${DICTIONARY_TABLE} n ON n.dict_id = d.dict_id
WHERE ${where}
ORDER BY d.dict_id, d.valid DESC, d.dict_value
LIMIT ${MAX_DICTIONARY_ROWS}`.trim()

  return {
    sql,
    values,
    meta: {
      mode: 'entries',
      dictId: params.dict_id,
      hasDictValue: params.dict_value !== null,
      hasKeyword: params.keyword !== null,
      includeDeprecated: params.include_deprecated,
    },
  }
}

function normalizeDictionaryEntry(row) {
  return {
    dictId: toInt(row.dict_id),
    dictName: toStringValue(row.dict_name),
    dictValue: toStringValue(row.dict_value),
    note: toStringValue(row.note),
    enabled: toInt(row.status) === 1,
    deprecated: toInt(row.valid) === 0,
  }
}

function normalizeCatalogRow(row) {
  return {
    dictId: toInt(row.dict_id),
    dictName: toStringValue(row.dict_name),
    deprecated: toInt(row.valid) === 0,
  }
}

export function normalizeDictionaryEntries(rows) {
  return Array.isArray(rows) ? rows.map(normalizeDictionaryEntry) : []
}

export function normalizeDictionaryCatalog(rows) {
  return Array.isArray(rows) ? rows.map(normalizeCatalogRow) : []
}

/** 只读执行字典查询；超时与取消沿用连接层的统一处理。 */
export async function runDictionaryLookup(config, input = {}, {
  createConnection,
  signal,
  now = () => new Date(),
} = {}) {
  const params = normalizeDictionaryParams(input)
  const discovery = isDictionaryDiscovery(params)

  const payload = await runDatabaseOperation(
    config,
    async connection => {
      if (discovery) {
        const [catalog] = await connection.query(CATALOG_SQL)
        return { entries: [], catalog }
      }
      const built = buildDictionaryValuesQuery(params)
      const [entries] = await connection.execute(built.sql, built.values)
      return { entries, catalog: [] }
    },
    { createConnection, signal, timeoutMs: resolveSecurityPolicy(config).queryTimeoutMs },
  )

  const entries = maskSensitiveRows(normalizeDictionaryEntries(payload.entries), config)
  return {
    mode: discovery ? 'catalog' : 'entries',
    filters: {
      dictId: params.dict_id,
      dictValue: params.dict_value,
      keyword: params.keyword,
      includeDeprecated: params.include_deprecated,
    },
    dictionaries: maskSensitiveRows(normalizeDictionaryCatalog(payload.catalog), config),
    entries,
    returned: entries.length,
    truncated: Array.isArray(payload.entries) && payload.entries.length >= MAX_DICTIONARY_ROWS,
    generatedAt: formatLocalDateTime(now()),
  }
}
