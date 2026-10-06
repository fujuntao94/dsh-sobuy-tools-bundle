import {
  DEFAULT_TIMELINE_LIMIT,
  MAX_TIMELINE_LIMIT,
  ORDER_TIMELINE_TABLES,
  runOrderTimeline,
} from '../../domains/order-timeline.js'
import { configPath, readConfig } from '../../storage/config-store.js'
import { errorKind } from '../../security/query-audit.js'

function hasDatabaseConfig(config) {
  return Boolean(config?.host && config?.port && config?.database && config?.username && config?.password)
}

const NUMBER = { type: 'number' }
const STRING = { type: 'string' }

function entryLine(entry, index) {
  const parts = [`${index + 1}. ${entry.createTime || '（无时间）'}  ${entry.operation || '（无操作类型）'}`]
  if (entry.reason) {
    parts.push(entry.reasonTranslated
      ? `原因码 ${entry.reason}（${entry.reasonNote}）`
      : `原因码 ${entry.reason}（字典中无此编码）`)
  }
  if (entry.information) parts.push(`说明：${entry.information}`)
  if (entry.operators) parts.push(`操作人：${entry.operators}`)
  return parts.join('  |  ')
}

export function createOrderTimelineTool({ dataDirectory, timeline = runOrderTimeline, auditLogger } = {}) {
  return {
    name: 'database_order_timeline',
    description: `只读返回单个订单的完整操作流水（oms_t_order_action，订单改单操作记录），按操作时间倒序，包含操作类型、原因码及其中文翻译、操作说明、操作人和时间。用于排查"这笔订单到底经历过什么、为什么被拦截/取消/改单"。原因码会自动翻译（字典 dict_id=3），翻译不到时原样返回编码。不接受 SQL。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['order_id'],
      properties: {
        order_id: {
          type: 'string', maxLength: 64,
          description: '订单号，例如 403-4266233-5557910 或 PO-186-12399759478314058。',
        },
        limit: {
          type: 'integer', minimum: 1, maximum: MAX_TIMELINE_LIMIT,
          description: `返回最近多少条流水，默认 ${DEFAULT_TIMELINE_LIMIT}，上限 ${MAX_TIMELINE_LIMIT}。单笔订单流水极值可达十万条以上，因此必须受限。`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['orderId', 'totalRecords', 'returned', 'mayBeTruncated', 'translatedReasons', 'untranslatedReasons', 'entries', 'generatedAt'],
        properties: {
          orderId: STRING,
          totalRecords: { type: 'number', description: '该订单的操作流水总条数。' },
          returned: { type: 'number', description: '本次实际返回的条数。' },
          mayBeTruncated: { type: 'boolean', description: '总条数大于返回条数时为 true。' },
          translatedReasons: { type: 'number', description: '本次返回中，原因码成功翻译成中文的条数。' },
          untranslatedReasons: { type: 'number', description: '本次返回中，有原因码但字典查不到的条数。' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['logid', 'operation', 'reason', 'reasonTranslated', 'createTime'],
              properties: {
                logid: NUMBER,
                operation: { type: 'string', description: '操作类型中文，例如 拦截、仓库已打单。' },
                operationEn: { type: 'string', description: '操作类型英文名。' },
                reason: { type: 'string', description: '原因码原文，可能为空。' },
                reasonNote: { type: 'string', description: '原因码的中文说明，查不到字典时为空。' },
                reasonTranslated: { type: 'boolean', description: '原因码是否成功翻译。为 false 时不要臆测含义。' },
                information: { type: 'string', description: '操作说明，机器生成的状态文本，最多 300 字符。' },
                operators: { type: 'string', description: '操作人。' },
                createTime: STRING,
              },
            },
          },
          generatedAt: STRING,
        },
      },
      render: (_args, value) => {
        if (!value.entries.length) {
          return [{
            type: 'text',
            text: `订单 ${value.orderId} 在操作流水表里没有任何记录。请确认订单号是否正确——该表存的是改单操作轨迹，未产生过操作的订单不会出现在这里。`,
          }]
        }
        const text = [
          `订单 ${value.orderId}：操作流水共 ${value.totalRecords} 条，本次返回最近 ${value.returned} 条（按操作时间倒序，生成于 ${value.generatedAt}）：`,
          ...value.entries.map(entryLine),
          '注意：原因码只在「拦截」类操作上才有值，它不是订单的通用原因字段。',
          value.untranslatedReasons
            ? `本次有 ${value.untranslatedReasons} 条原因码在本库字典里查不到：原因码是混合编码，只有 G 码（如 G17=缺货）有字典，数字码与中文码没有对应字典，请原样引用不要臆测含义。`
            : null,
          value.mayBeTruncated
            ? `该订单流水超过 ${value.returned} 条，部分较早记录未显示；需要更多可用 limit 参数（上限 ${MAX_TIMELINE_LIMIT}）。`
            : null,
        ].filter(Boolean).join('\n')
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const startedAt = Date.now()
      const meta = {}
      if (exec?.signal?.aborted) throw new Error('订单时间线查询已取消。')
      const config = await readConfig(dataDirectory)
      if (!hasDatabaseConfig(config)) {
        throw new Error(`请先在数据库设置页保存完整连接信息。配置文件位置：${configPath(dataDirectory)}`)
      }
      try {
        const result = await timeline(config, args, { signal: exec?.signal })
        meta.rowCount = result.returned
        meta.appliedLimit = result.returned
        auditLogger?.record({
          operation: 'order_timeline', status: 'success', table: ORDER_TIMELINE_TABLES[0],
          ...meta, durationMs: Math.max(0, Date.now() - startedAt),
        })
        return result
      } catch (error) {
        auditLogger?.record({
          operation: 'order_timeline', status: 'error', table: ORDER_TIMELINE_TABLES[0],
          ...meta, errorKind: errorKind(error), durationMs: Math.max(0, Date.now() - startedAt),
        })
        if (exec?.signal?.aborted) throw new Error('订单时间线查询已取消。')
        if (error?.code === 'DATABASE_QUERY_TIMEOUT' || error?.code === 'DATABASE_QUERY_CANCELLED') throw error
        // 参数与白名单错误可以直接告诉模型；其余驱动类错误不外泄连接细节。
        if (/白名单|不支持参数|不能为空|长度不能超过|必须是|包含无效字符/.test(String(error?.message))) throw error
        throw new Error('无法完成订单时间线查询，请检查数据库设置、网络和只读账号权限。')
      }
    },
  }
}

export function registerOrderTimelineTool(ctx, options) {
  return ctx.tools.register(createOrderTimelineTool(options))
}
