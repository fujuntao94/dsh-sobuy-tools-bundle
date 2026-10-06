import {
  DEFAULT_TOP_N,
  DEFAULT_WINDOW_DAYS,
  MAX_TOP_N,
  MAX_WINDOW_DAYS,
  SOLD_OUT_ATTRIBUTION_TABLES,
  runSoldoutAttribution,
} from '../../domains/soldout-attribution.js'
import { configPath, readConfig } from '../../storage/config-store.js'
import { errorKind } from '../../security/query-audit.js'

function hasDatabaseConfig(config) {
  return Boolean(config?.host && config?.port && config?.database && config?.username && config?.password)
}

const NUMBER = { type: 'number' }
const STRING = { type: 'string' }

function rowLines(row, index) {
  const scope = row.sku
    ? `${row.sku} @ ${row.warehouseName}(${row.warehouseId})`
    : `${row.warehouseName}(${row.warehouseId})`
  const state = row.currentState === 'recovered_or_closed' ? '已恢复或已关闭' : row.currentState === 'mixed' ? '历史状态混合' : '当前待处理'
  const headline = `${index + 1}. ${scope}${row.priority ? ` [${row.priority}]` : ''}：缺货 ${row.soldoutRows} 行 / ${row.orderCount} 单 / ${row.quantitySum} 件${
    row.lastSoldoutTime ? `，最近 ${row.lastSoldoutTime}` : ''}`
  if (!row.attribution) {
    return [`${headline}；涉及 SKU ${row.skuCount} 个`]
  }
  const evidence = [
    `发货仓可用 ${row.localAvailable}`,
    `其他仓可用 ${row.otherWarehouseAvailable}`,
    row.hasWarning ? `预警预售量 ${row.warningPresellNum}` : '未查到库存预警',
    row.hasWarning ? (row.warningDealFlag === 1 ? '预警已处理' : '预警未处理') : null,
    row.soldoutStateRows ? `已断货 ${row.soldoutStateRows} 行` : null,
    row.processingRows ? `缺货处理中 ${row.processingRows} 行` : null,
  ].filter(Boolean)
  return [
    headline,
    `   原因：${row.attributionNote}`,
    row.currentState ? `   状态：${state}${row.waitHours !== undefined ? `，已等待 ${row.waitHours} 小时` : ''}` : null,
    `   依据：${evidence.join('；')}`,
    row.primaryAction ? `   建议：${row.primaryAction}` : null,
    row.contributingFactors?.length
      ? `   并发因素：${row.contributingFactors.map(factor => factor.label).join('；')}`
      : null,
  ]
    .filter(Boolean)
}

export function createSoldoutAttributionTool({
  dataDirectory,
  attribution = runSoldoutAttribution,
  auditLogger,
} = {}) {
  return {
    name: 'database_soldout_attribution',
    description: `只读分析近 N 天的订单缺货情况：默认只看当前仍待处理的缺货订单，可按 SKU×仓库或仓库聚合；对照当前库存、库存明细、库存预警和关联预售货柜，返回主因、并发因素及下一步动作。时间锚点是下单时间，窗口上限 ${MAX_WINDOW_DAYS} 天。不接受 SQL，只返回 SKU、仓库和数量，不返回客户隐私字段。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        window_days: {
          type: 'integer', minimum: 1, maximum: MAX_WINDOW_DAYS,
          description: `统计窗口天数，按订单下单时间筛选，默认 ${DEFAULT_WINDOW_DAYS}，上限 ${MAX_WINDOW_DAYS}。`,
        },
        group_by: {
          type: 'string', enum: ['sku', 'warehouse'],
          description: '聚合维度：sku 返回 SKU 与仓库组合的缺货归因（含原因推断）；warehouse 返回仓库维度的缺货分布。默认 sku。',
        },
        scope: {
          type: 'string', enum: ['active', 'historical'],
          description: '统计口径：active（默认）只看当前未发货、未撤单、未取消的缺货状态；historical 保留窗口内曾符合缺货口径的历史订单。',
        },
        warehouse_id: {
          type: 'integer', minimum: 1,
          description: '可选。只统计指定发货仓库 ID，用于单仓下钻。',
        },
        top_n: {
          type: 'integer', minimum: 1, maximum: MAX_TOP_N,
          description: `返回条数上限，按缺货行数倒序，默认 ${DEFAULT_TOP_N}，上限 ${MAX_TOP_N}。`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['windowDays', 'groupBy', 'scope', 'generatedAt', 'groups', 'actionSummary', 'rows'],
        properties: {
          windowDays: NUMBER,
          groupBy: STRING,
          scope: STRING,
          generatedAt: STRING,
          groups: { type: 'number', description: '本次返回的分组条数。' },
          actionSummary: {
            type: 'object', additionalProperties: false,
            required: ['scope', 'byReason', 'byWarehouse', 'byOwner'],
            properties: {
              scope: STRING,
              byReason: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['reason', 'groups', 'orderCount', 'quantitySum'], properties: { reason: STRING, groups: NUMBER, orderCount: NUMBER, quantitySum: NUMBER } } },
              byWarehouse: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['warehouse', 'groups', 'orderCount', 'quantitySum'], properties: { warehouse: STRING, groups: NUMBER, orderCount: NUMBER, quantitySum: NUMBER } } },
              byOwner: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['owner', 'groups', 'orderCount', 'quantitySum'], properties: { owner: STRING, groups: NUMBER, orderCount: NUMBER, quantitySum: NUMBER } } },
            },
          },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['soldoutRows', 'orderCount', 'quantitySum'],
              properties: {
                sku: STRING,
                warehouseId: NUMBER,
                warehouseName: STRING,
                skuCount: { type: 'number', description: '仅 group_by=warehouse 时返回，涉及的 SKU 个数。' },
                soldoutRows: { type: 'number', description: '缺货行数。' },
                orderCount: { type: 'number', description: '去重后的订单数。' },
                quantitySum: { type: 'number', description: '缺货数量合计。' },
                lastSoldoutTime: STRING,
                oldestShortageTime: STRING,
                currentState: { type: 'string', description: '仅 group_by=sku 时返回：active、recovered_or_closed 或 mixed。' },
                soldoutStateRows: { type: 'number', description: '状态为已断货(3D|3D)的行数。' },
                processingRows: { type: 'number', description: '状态为订单缺货处理(1A|06)的行数。' },
                insufficientRows: { type: 'number', description: '状态为库存不足(1A|04)的行数。' },
                presaleRows: { type: 'number', description: '状态为预售(1A|2C)的行数。' },
                occupiedRows: { type: 'number', description: '已占用库存的行数。' },
                shippedRows: { type: 'number', description: '仅 historical 口径可能出现，已发货行数。' },
                closedRows: { type: 'number', description: '仅 historical 口径可能出现，已取消或撤单行数。' },
                sampleContainerNum: { type: 'string', description: 'SKU 分组关联的一个货柜样本，不代表全部货柜。' },
                containerCount: { type: 'number', description: '该分组关联的不同货柜数。' },
                containerEtaStore: { type: 'string', description: '关联货柜样本的预计到库时间。' },
                containerAtaStore: { type: 'string', description: '关联货柜样本的实际到库时间。' },
                containerPresaleExpire: { type: 'string', description: '关联货柜样本的预售截止时间。' },
                containerPresaleStatus: { type: 'number', description: '关联货柜样本的预售状态。' },
                localAvailable: { type: 'number', description: '仅 group_by=sku 时返回，发货仓当前可用库存。' },
                localUsednum: { type: 'number', description: '仅 group_by=sku 时返回，发货仓现货占用数量。' },
                localStockStatus: { type: 'number', description: '仅 group_by=sku 时返回，库存上架状态。' },
                localStockUpdatedAt: STRING,
                localPresaleOccupied: { type: 'number', description: '仅 group_by=sku 时返回，库存明细中的预售占用数量。' },
                otherWarehouseAvailable: { type: 'number', description: '仅 group_by=sku 时返回，其他仓库当前可用库存合计。' },
                transferCandidates: { type: 'string', description: '仅 group_by=sku 时返回，其他仓的候选调拨库存，不代表已创建调拨任务。' },
                pendingShelvingTasks: { type: 'number', description: '仅 group_by=sku 时返回，未完成的预售或现货上架任务数。' },
                pendingTaskOwners: { type: 'string', description: '仅 group_by=sku 时返回，未完成上架任务的责任人。' },
                warningPresellNum: { type: 'number', description: '仅 group_by=sku 时返回，库存预警的预售量。' },
                warningCriticalValue: { type: 'number', description: '仅 group_by=sku 时返回，库存预警的临界值 A。' },
                warningDealFlag: NUMBER,
                warningCreateTime: STRING,
                hasWarning: { type: 'boolean', description: '仅 group_by=sku 时返回，是否匹配到库存预警记录。' },
                attribution: { type: 'string', description: '仅 group_by=sku 时返回，缺货原因枚举。' },
                attributionNote: { type: 'string', description: '仅 group_by=sku 时返回，原因的中文说明与判定依据。' },
                primaryAction: { type: 'string', description: '仅 group_by=sku 时返回，主因对应的下一步动作。' },
                confidence: { type: 'string', description: '仅 group_by=sku 时返回，当前证据的置信度。' },
                contributingFactors: {
                  type: 'array',
                  description: '仅 group_by=sku 时返回，不影响主因判断的并发因素。',
                  items: {
                    type: 'object', additionalProperties: false,
                    required: ['code', 'label', 'evidence', 'action'],
                    properties: { code: STRING, label: STRING, evidence: STRING, action: STRING },
                  },
                },
                recommendedActions: { type: 'array', items: STRING, description: '仅 group_by=sku 时返回，去重后的建议动作。' },
                waitHours: { type: 'number', description: '仅 group_by=sku 时返回，自最早缺货或下单时间起的等待小时数。' },
                priority: { type: 'string', description: '仅 group_by=sku 时返回，P0 至 P3 的待办优先级。' },
                priorityScore: { type: 'number', description: '仅 group_by=sku 时返回，用于待办排序的内部评分。' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.rows.length) {
          return [{ type: 'text', text: `近 ${value.windowDays} 天没有发现符合缺货口径的订单记录。` }]
        }
        const dimension = value.groupBy === 'warehouse' ? '仓库' : 'SKU 与仓库'
        const summary = value.actionSummary?.byReason?.length
          ? `待办汇总（本次返回范围）：${value.actionSummary.byReason.map(item => `${item.reason} ${item.quantitySum} 件`).join('；')}`
          : null
        const text = [
          `近 ${value.windowDays} 天缺货归因（${value.scope === 'active' ? '当前待处理口径' : '历史缺货口径'}，按${dimension}聚合，共 ${value.groups} 条，时间锚点为下单时间，生成于 ${value.generatedAt}）：`,
          summary,
          ...value.rows.flatMap((row, index) => rowLines(row, index)),
          value.groupBy === 'sku'
            ? '注意：主因、并发因素和动作均基于当前库存、预警及关联货柜推断，不是数据库中的原因字段；库存为当前快照，货柜仅使用关联样本。'
            : '注意：仓库维度不推断原因，只反映缺货分布；需要原因请改用 group_by=sku。',
        ].join('\n')
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const startedAt = Date.now()
      let meta = {}
      if (exec?.signal?.aborted) throw new Error('缺货归因查询已取消。')
      const config = await readConfig(dataDirectory)
      if (!hasDatabaseConfig(config)) {
        throw new Error(`请先在数据库设置页保存完整连接信息。配置文件位置：${configPath(dataDirectory)}`)
      }
      try {
        const result = await attribution(config, args, { signal: exec?.signal })
        meta = { windowDays: result.windowDays, groupBy: result.groupBy, appliedLimit: result.groups }
        auditLogger?.record({
          operation: 'soldout_attribution', status: 'success', table: SOLD_OUT_ATTRIBUTION_TABLES[0],
          rowCount: result.groups, ...meta, durationMs: Math.max(0, Date.now() - startedAt),
        })
        return result
      } catch (error) {
        auditLogger?.record({
          operation: 'soldout_attribution', status: 'error', table: SOLD_OUT_ATTRIBUTION_TABLES[0],
          ...meta, errorKind: errorKind(error), durationMs: Math.max(0, Date.now() - startedAt),
        })
        if (exec?.signal?.aborted) throw new Error('缺货归因查询已取消。')
        if (error?.code === 'DATABASE_QUERY_TIMEOUT' || error?.code === 'DATABASE_QUERY_CANCELLED') throw error
        // 参数与白名单错误可以直接告诉模型；其余驱动类错误不外泄连接细节。
        if (/白名单|不支持参数|整数|只支持/.test(String(error?.message))) throw error
        throw new Error('无法完成缺货归因查询，请检查数据库设置、网络和只读账号权限。')
      }
    },
  }
}

export function registerSoldoutAttributionTool(ctx, options) {
  return ctx.tools.register(createSoldoutAttributionTool(options))
}
