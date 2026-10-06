import { formatLocalDateTime } from '../../domains/format.js'
import { runSoldoutAttribution } from '../../domains/soldout-attribution.js'
import { configPath, readConfig } from '../../storage/config-store.js'
import {
  compareLatestSoldoutSnapshots,
  readSoldoutSnapshots,
  saveSoldoutSnapshot,
} from '../../storage/soldout-snapshot-store.js'
import { errorKind } from '../../security/query-audit.js'

const NUMBER = { type: 'number' }
const STRING = { type: 'string' }
const MAX_SNAPSHOT_ROWS = 500

function hasDatabaseConfig(config) {
  return Boolean(config?.host && config?.port && config?.database && config?.username && config?.password)
}

function snapshotRow(row) {
  return {
    sku: row.sku,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouseName,
    soldoutRows: row.soldoutRows,
    orderCount: row.orderCount,
    quantitySum: row.quantitySum,
    oldestShortageTime: row.oldestShortageTime,
    localAvailable: row.localAvailable,
    otherWarehouseAvailable: row.otherWarehouseAvailable,
    attribution: row.attribution,
    currentState: row.currentState,
    priority: row.priority,
  }
}

export function createSoldoutSnapshotCaptureTool({
  dataDirectory,
  attribution = runSoldoutAttribution,
  now = () => new Date(),
  auditLogger,
} = {}) {
  return {
    name: 'database_soldout_snapshot_capture',
    description: '从 OMS 只读采集当前待处理缺货队列的前 500 个 SKU×仓库分组，并保存到插件私有目录。快照不会写入任何 OMS 数据表；每天重复采集会覆盖当天快照。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        window_days: { type: 'integer', minimum: 1, maximum: 45, description: '按下单时间筛选的窗口天数，默认 30。' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        required: ['capturedAt', 'windowDays', 'capturedGroups', 'replacedSnapshot', 'snapshotsRetained'],
        properties: {
          capturedAt: STRING,
          windowDays: NUMBER,
          capturedGroups: NUMBER,
          replacedSnapshot: { type: 'boolean' },
          snapshotsRetained: NUMBER,
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已采集 ${value.capturedGroups} 条当前待处理缺货分组快照（${value.capturedAt}）；${value.replacedSnapshot ? '已覆盖当天旧快照' : '已新增当天快照'}，当前保留 ${value.snapshotsRetained} 份。` }],
    },
    async execute(args, exec) {
      const startedAt = Date.now()
      const config = await readConfig(dataDirectory)
      if (!hasDatabaseConfig(config)) throw new Error(`请先在数据库设置页保存完整连接信息。配置文件位置：${configPath(dataDirectory)}`)
      try {
        const result = await attribution(config, {
          window_days: args?.window_days,
          scope: 'active',
          group_by: 'sku',
          top_n: MAX_SNAPSHOT_ROWS,
        }, { signal: exec?.signal, now })
        const capturedAt = formatLocalDateTime(now())
        const saved = await saveSoldoutSnapshot({
          capturedAt,
          windowDays: result.windowDays,
          rows: result.rows.map(snapshotRow),
        }, dataDirectory)
        auditLogger?.record({ operation: 'soldout_snapshot_capture', status: 'success', rowCount: result.rows.length, durationMs: Math.max(0, Date.now() - startedAt) })
        return { capturedAt, windowDays: result.windowDays, capturedGroups: result.rows.length, replacedSnapshot: saved.replaced, snapshotsRetained: saved.retained }
      } catch (error) {
        auditLogger?.record({ operation: 'soldout_snapshot_capture', status: 'error', errorKind: errorKind(error), durationMs: Math.max(0, Date.now() - startedAt) })
        if (exec?.signal?.aborted) throw new Error('缺货快照采集已取消。')
        throw error
      }
    },
  }
}

export function createSoldoutSnapshotCompareTool({ dataDirectory, auditLogger } = {}) {
  return {
    name: 'database_soldout_snapshot_compare',
    description: '只读比较插件私有目录中的最近两份数据库缺货快照，返回新增、已解决、持续和恶化的 SKU×仓库分组数量。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        required: ['available', 'reason', 'previousCapturedAt', 'latestCapturedAt', 'previousGroups', 'latestGroups', 'newGroups', 'resolvedGroups', 'continuingGroups', 'worsenedGroups'],
        properties: {
          available: { type: 'boolean' }, reason: STRING, previousCapturedAt: STRING, latestCapturedAt: STRING,
          previousGroups: NUMBER, latestGroups: NUMBER, newGroups: NUMBER, resolvedGroups: NUMBER, continuingGroups: NUMBER, worsenedGroups: NUMBER,
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.available
        ? `快照对比：新增 ${value.newGroups} 组，已解决 ${value.resolvedGroups} 组，持续 ${value.continuingGroups} 组，缺货量恶化 ${value.worsenedGroups} 组。`
        : value.reason }],
    },
    async execute() {
      const startedAt = Date.now()
      try {
        const comparison = compareLatestSoldoutSnapshots((await readSoldoutSnapshots(dataDirectory)).snapshots)
        const value = {
          available: comparison.available,
          reason: comparison.reason || '',
          previousCapturedAt: comparison.previousCapturedAt || '',
          latestCapturedAt: comparison.latestCapturedAt || '',
          previousGroups: comparison.previousGroups || 0,
          latestGroups: comparison.latestGroups || 0,
          newGroups: comparison.newGroups || 0,
          resolvedGroups: comparison.resolvedGroups || 0,
          continuingGroups: comparison.continuingGroups || 0,
          worsenedGroups: comparison.worsenedGroups || 0,
        }
        auditLogger?.record({ operation: 'soldout_snapshot_compare', status: 'success', rowCount: value.latestGroups, durationMs: Math.max(0, Date.now() - startedAt) })
        return value
      } catch (error) {
        auditLogger?.record({ operation: 'soldout_snapshot_compare', status: 'error', errorKind: errorKind(error), durationMs: Math.max(0, Date.now() - startedAt) })
        throw new Error('无法读取缺货快照，请检查插件私有数据目录。')
      }
    },
  }
}

export function registerSoldoutSnapshotTools(ctx, options) {
  return [
    ctx.tools.register(createSoldoutSnapshotCaptureTool(options)),
    ctx.tools.register(createSoldoutSnapshotCompareTool(options)),
  ]
}
