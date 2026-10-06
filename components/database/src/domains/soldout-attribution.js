/**
 * 缺货归因分析。
 *
 * 与 safe-select.js 的区别：这里的 SQL 是**代码内固定**的聚合模板，模型只能选择
 * 模板和填参数，永远接触不到 SQL 字符串或表名，因此不需要开放任意 SQL。
 * 三个数据源、聚合维度、时间锚点全部写死在文件里。
 *
 * 时间锚点用 `order_time`（下单时间）而不是 `soldout_time`：一来 soldout_time
 * 上没有索引（表 273 万行，全表扫描会撞超时），二来 `1A|06`、`1A|04` 这类缺货
 * 状态的 soldout_time 是空的，用它会漏掉整个"缺货处理中"队列。
 */
import { runDatabaseOperation } from './connection.js'
import { formatLocalDateTime } from './format.js'
import { resolveSecurityPolicy } from '../security/policy.js'
import { maskSensitiveRows } from '../security/sensitive-fields.js'

const TRACKING_TABLE = 'oms_t_orders_tracking'
const INVENTORY_TABLE = 'oms_t_inventory'
const INVENTORY_DETAIL_TABLE = 'oms_t_inventory_detail'
const WARNING_TABLE = 'early_warn_inventory_info'
const CONTAINER_TABLE = 'bas_t_container'
const CONTAINER_SKU_TABLE = 'bas_t_container_sku'
const WORK_STOCK_TABLE = 'bas_t_work_stock'

/** 缺货归因只读固定来源表；调用方不能传入表名或 SQL。 */
export const SOLD_OUT_ATTRIBUTION_TABLES = Object.freeze([
  TRACKING_TABLE, INVENTORY_TABLE, INVENTORY_DETAIL_TABLE, WARNING_TABLE,
  CONTAINER_TABLE, CONTAINER_SKU_TABLE, WORK_STOCK_TABLE,
])

export const DEFAULT_WINDOW_DAYS = 30
/** historical 实测：7 天 0.6s / 30 天 0.7s / 45 天 1.0s，但 60 天会跳到 13.9s 并撞 5s 超时。 */
export const MAX_WINDOW_DAYS = 45
export const DEFAULT_TOP_N = 20
export const MAX_TOP_N = 500

export const ATTRIBUTION_GROUPS = Object.freeze(['sku', 'warehouse'])
export const ATTRIBUTION_SCOPES = Object.freeze(['active', 'historical'])

export const ATTRIBUTION_LABELS = Object.freeze({
  local_stock_resolved: '发货仓当前已有可用库存',
  warehouse_allocation_gap: '发货仓无货、其他仓有候选调拨库存',
  local_stock_occupied: '本仓现货已被占用',
  presale_occupation: '预售占用可发库存',
  container_in_transit: '关联预售货柜尚未到库',
  shelving_pending: '现货或预售上架任务未完成',
  warning_unhandled: '库存预警已触发但未处理',
  genuine_shortage: '真实缺货（各仓均无可用）',
})

/**
 * 缺货口径：断货时间有值，或处于库内缺货相关状态。
 * 状态码含义见 bas_t_status 字典；未加 valid=1 会混进 118 行历史噪声。
 */
const SHORTAGE_CONDITION = [
  'soldout_time IS NOT NULL',
  "(status_one = '3D' AND status_two = '3D')",
  "(status_one = '1A' AND status_two = '06')",
  "(status_one = '1A' AND status_two = '04')",
  "(status_one = '1A' AND status_two = '2C')",
].join('\n      OR ')

const ALLOWED_PARAMS = new Set(['window_days', 'group_by', 'warehouse_id', 'top_n', 'scope'])

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
export function normalizeAttributionParams(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('缺货归因参数无效。')
  const unknown = Object.keys(input).filter(key => !ALLOWED_PARAMS.has(key))
  if (unknown.length) throw new Error(`缺货归因不支持参数：${unknown.join('、')}。`)

  const groupBy = input.group_by === undefined || input.group_by === null ? 'sku' : String(input.group_by)
  if (!ATTRIBUTION_GROUPS.includes(groupBy)) throw new Error('缺货归因的 group_by 只支持 sku 或 warehouse。')
  const scope = input.scope === undefined || input.scope === null ? 'active' : String(input.scope)
  if (!ATTRIBUTION_SCOPES.includes(scope)) throw new Error('缺货归因的 scope 只支持 active 或 historical。')

  return {
    window_days: input.window_days === undefined || input.window_days === null
      ? DEFAULT_WINDOW_DAYS
      : positiveInteger(input.window_days, 'window_days', { minimum: 1, maximum: MAX_WINDOW_DAYS }),
    top_n: input.top_n === undefined || input.top_n === null
      ? DEFAULT_TOP_N
      : positiveInteger(input.top_n, 'top_n', { minimum: 1, maximum: MAX_TOP_N }),
    group_by: groupBy,
    scope,
    warehouse_id: input.warehouse_id === undefined || input.warehouse_id === null
      ? null
      : positiveInteger(input.warehouse_id, 'warehouse_id', { minimum: 1, maximum: 2147483647 }),
  }
}

/**
 * 缺货口径。active 是全量当前待处理队列，不能因为下单超过 45 天而遗漏；
 * historical 才使用时间窗，避免历史复盘扫描无边界增长。仓库过滤由调用方单独拼接，
 * 避免 `warehouse_id = ?` 重复出现导致占位符数量与参数个数不一致。
 */
function trackingFilter(scope) {
  const activeCondition = [
    "(status_one = '3D' AND status_two = '3D')",
    "(status_one = '1A' AND status_two = '06')",
    "(status_one = '1A' AND status_two = '04')",
    "(status_one = '1A' AND status_two = '2C')",
  ].join('\n      OR ')
  const scopeCondition = scope === 'active'
    ? `(${activeCondition})\n    AND COALESCE(is_send, 0) <> 1\n    AND COALESCE(has_withdrawn, 0) = 0\n    AND cancel_time IS NULL`
    : `(${SHORTAGE_CONDITION})`
  return [
    'valid = 1',
    ...(scope === 'historical' ? ['order_time >= DATE_SUB(NOW(), INTERVAL ? DAY)'] : []),
    scopeCondition,
  ].join('\n    AND ')
}

const SKU_AGGREGATE_COLUMNS = `
    COUNT(*) AS soldout_rows,
    COUNT(DISTINCT order_id) AS order_count,
    CAST(COALESCE(SUM(quantity), 0) AS SIGNED) AS quantity_sum,
    DATE_FORMAT(MAX(soldout_time), '%Y-%m-%d %H:%i:%s') AS last_soldout_time,
    CAST(SUM(status_one = '3D' AND status_two = '3D') AS SIGNED) AS soldout_state_rows,
    CAST(SUM(status_one = '1A' AND status_two = '06') AS SIGNED) AS processing_rows,
    CAST(SUM(status_one = '1A' AND status_two = '04') AS SIGNED) AS insufficient_rows,
    CAST(SUM(status_one = '1A' AND status_two = '2C') AS SIGNED) AS presale_rows,
    CAST(SUM(COALESCE(is_occupy, 0) = 1) AS SIGNED) AS occupied_rows,
    CAST(COUNT(DISTINCT DATE(order_time)) AS SIGNED) AS shortage_days,
    CAST(SUM(plan_print_time IS NOT NULL AND plan_print_time < NOW()) AS SIGNED) AS overdue_ship_rows,
    DATE_FORMAT(MIN(plan_print_time), '%Y-%m-%d %H:%i:%s') AS earliest_plan_print_time,
    CAST(SUM(COALESCE(is_send, 0) = 1) AS SIGNED) AS shipped_rows,
    CAST(SUM(COALESCE(has_withdrawn, 0) = 1 OR cancel_time IS NOT NULL) AS SIGNED) AS closed_rows,
    DATE_FORMAT(MIN(COALESCE(soldout_time, order_time)), '%Y-%m-%d %H:%i:%s') AS oldest_shortage_time,
    MAX(NULLIF(container_num, '')) AS sample_container_num,
    CAST(COUNT(DISTINCT NULLIF(container_num, '')) AS SIGNED) AS container_count`

/**
 * 生成缺货归因查询。返回单条 SELECT：只有代码常量与占位符，没有任何字符串拼接的用户输入。
 */
export function buildSoldoutAttributionQuery(input = {}) {
  const params = normalizeAttributionParams(input)
  const hasWarehouseFilter = params.warehouse_id !== null
  const hasTimeWindow = params.scope === 'historical'
  const warehouseFilter = hasWarehouseFilter ? ' AND warehouse_id = ?' : ''
  const filter = trackingFilter(params.scope)

  const sql = params.group_by === 'sku'
    ? `
SELECT
  grouped.sku,
  grouped.warehouse_id,
  grouped.warehouse_name,
  grouped.soldout_rows,
  grouped.order_count,
  grouped.quantity_sum,
  grouped.last_soldout_time,
  grouped.soldout_state_rows,
  grouped.processing_rows,
  grouped.insufficient_rows,
  grouped.presale_rows,
  grouped.occupied_rows,
  grouped.shortage_days,
  grouped.overdue_ship_rows,
  grouped.earliest_plan_print_time,
  grouped.shipped_rows,
  grouped.closed_rows,
  grouped.oldest_shortage_time,
  grouped.sample_container_num,
  grouped.container_count,
  CAST(COALESCE(local_stock.available, 0) AS SIGNED) AS local_available,
  CAST(COALESCE(local_stock.usednum, 0) AS SIGNED) AS local_usednum,
  COALESCE(local_stock.status, 9) AS local_stock_status,
  DATE_FORMAT(local_stock.update_time, '%Y-%m-%d %H:%i:%s') AS local_stock_updated_at,
  CAST(COALESCE(local_detail.presale_occupied, 0) AS SIGNED) AS local_presale_occupied,
  CAST(COALESCE((
    SELECT SUM(other_inventory.available)
    FROM ${INVENTORY_TABLE} other_inventory
    WHERE other_inventory.p_sku = grouped.sku
      AND other_inventory.wsid <> grouped.warehouse_id
      AND other_inventory.available > 0
  ), 0) AS SIGNED) AS other_warehouse_available,
  COALESCE((
    SELECT LEFT(GROUP_CONCAT(CONCAT(other_inventory.wsname, '(', other_inventory.wsid, '):', other_inventory.available)
      ORDER BY other_inventory.available DESC SEPARATOR '、'), 500)
    FROM ${INVENTORY_TABLE} other_inventory
    WHERE other_inventory.p_sku = grouped.sku
      AND other_inventory.wsid <> grouped.warehouse_id
      AND other_inventory.available > 0
  ), '') AS transfer_candidates,
  CAST(COALESCE(warning.presell_num, 0) AS SIGNED) AS warning_presell_num,
  CAST(COALESCE(warning.critical_value_a, 0) AS SIGNED) AS warning_critical_value,
  warning.deal_flag AS warning_deal_flag,
  CASE WHEN warning.sku IS NULL THEN 0 ELSE 1 END AS has_warning,
  DATE_FORMAT(warning.create_time, '%Y-%m-%d %H:%i:%s') AS warning_create_time,
  DATE_FORMAT(container.eta_store, '%Y-%m-%d') AS container_eta_store,
  DATE_FORMAT(container.ata_store, '%Y-%m-%d') AS container_ata_store,
  DATE_FORMAT(container.presale_expire, '%Y-%m-%d') AS container_presale_expire,
  container_sku.status AS container_presale_status,
  CAST(COALESCE(container_sku.load_qty, 0) AS SIGNED) AS container_load_qty,
  CAST(COALESCE(work_stock.pending_shelving_tasks, 0) AS SIGNED) AS pending_shelving_tasks,
  COALESCE(work_stock.pending_task_owners, '') AS pending_task_owners,
  DATE_FORMAT(work_stock.oldest_shelving_task_created_at, '%Y-%m-%d %H:%i:%s') AS oldest_shelving_task_created_at
FROM (
  SELECT
    sku,
    warehouse_id,
    warehouse_name,${SKU_AGGREGATE_COLUMNS}
  FROM ${TRACKING_TABLE}
  WHERE ${filter}${warehouseFilter}
  GROUP BY sku, warehouse_id, warehouse_name
) grouped
LEFT JOIN ${INVENTORY_TABLE} local_stock
  ON local_stock.p_sku = grouped.sku AND local_stock.wsid = grouped.warehouse_id
LEFT JOIN (
  SELECT
    inventory.p_sku,
    inventory.wsid,
    CAST(SUM(COALESCE(detail.pre_usednum_qty, 0)) AS SIGNED) AS presale_occupied
  FROM ${INVENTORY_TABLE} inventory
  INNER JOIN ${INVENTORY_DETAIL_TABLE} detail
    ON detail.inventory_id = inventory.id AND detail.valid = 1
  GROUP BY inventory.p_sku, inventory.wsid
) local_detail ON local_detail.p_sku = grouped.sku AND local_detail.wsid = grouped.warehouse_id
LEFT JOIN ${WARNING_TABLE} warning
  ON warning.id = (
    SELECT latest_warning.id
    FROM ${WARNING_TABLE} latest_warning
    WHERE latest_warning.sku = grouped.sku
      AND latest_warning.warehouse_id = grouped.warehouse_id
      AND latest_warning.is_delete = 0
    ORDER BY COALESCE(latest_warning.update_time, latest_warning.create_time) DESC, latest_warning.id DESC
    LIMIT 1
  )
LEFT JOIN ${CONTAINER_TABLE} container
  ON container.container_num = grouped.sample_container_num
LEFT JOIN ${CONTAINER_SKU_TABLE} container_sku
  ON container_sku.container_num = grouped.sample_container_num
  AND container_sku.sku = grouped.sku
  AND container_sku.valid = 1
LEFT JOIN (
  SELECT
    sku,
    warehouse_id,
    CAST(SUM(CASE WHEN type IN (1, 3) AND is_finish_status = 0 THEN 1 ELSE 0 END) AS SIGNED) AS pending_shelving_tasks,
    LEFT(GROUP_CONCAT(DISTINCT NULLIF(duty_user_name, '') ORDER BY duty_user_name SEPARATOR '、'), 300) AS pending_task_owners,
    MIN(create_time) AS oldest_shelving_task_created_at
  FROM ${WORK_STOCK_TABLE}
  WHERE is_finish_status = 0
    AND type IN (1, 3)
  GROUP BY sku, warehouse_id
) work_stock ON work_stock.sku = grouped.sku AND work_stock.warehouse_id = grouped.warehouse_id
ORDER BY grouped.soldout_rows DESC, grouped.quantity_sum DESC
LIMIT ?`
    : `
SELECT
  warehouse_id,
  warehouse_name,${SKU_AGGREGATE_COLUMNS},
  CAST(COUNT(DISTINCT sku) AS SIGNED) AS sku_count
FROM ${TRACKING_TABLE}
WHERE ${filter}${warehouseFilter}
GROUP BY warehouse_id, warehouse_name
ORDER BY soldout_rows DESC, quantity_sum DESC
LIMIT ?`

  const values = [
    ...(hasTimeWindow ? [params.window_days] : []),
    ...(hasWarehouseFilter ? [params.warehouse_id] : []),
    params.top_n,
  ]

  return {
    sql: sql.trim(),
    values,
    meta: {
      groupBy: params.group_by,
      scope: params.scope,
      windowDays: params.window_days,
      appliedLimit: params.top_n,
      hasWarehouseFilter,
      timeRange: hasTimeWindow ? `last_${params.window_days}_days` : 'all_active',
    },
  }
}

/**
 * 缺货原因判定。
 *
 * 这是**启发式推断**，不是数据库里读出来的字段——库里没有"缺货原因"这一列。
 * 返回主因之外的并发因素和下一步动作，避免把复合问题压成一个互斥标签。
 */
export function classifyAttribution(row = {}) {
  const localAvailable = toInt(row.local_available)
  const localUsed = toInt(row.local_usednum)
  const localPresaleOccupied = toInt(row.local_presale_occupied)
  const otherAvailable = toInt(row.other_warehouse_available)
  const presaleRows = toInt(row.presale_rows)
  const warningPresellNum = toInt(row.warning_presell_num)
  const dealFlag = toInt(row.warning_deal_flag)
  const hasWarning = toInt(row.has_warning) === 1
  const pendingShelvingTasks = toInt(row.pending_shelving_tasks)
  const pendingTaskOwners = toStringValue(row.pending_task_owners)
  const containerInTransit = toInt(row.container_presale_status) === 1 && !toStringValue(row.container_ata_store)
  const factors = []
  const addFactor = (code, label, evidence, action) => factors.push({ code, label, evidence, action })

  if (localAvailable > 0) {
    addFactor('local_stock_resolved', '发货仓当前已有可用库存', `发货仓当前可用 ${localAvailable}。`, '核对订单是否仍未推仓、未拣货或未打单。')
  }
  if (otherAvailable > 0) {
    const candidates = toStringValue(row.transfer_candidates)
    addFactor('warehouse_allocation_gap', '其他仓存在可调拨库存', `发货仓可用 0；其他仓合计可用 ${otherAvailable}${candidates ? `，候选仓：${candidates}` : ''}。`, '优先核实候选仓可调拨性与调拨时效。')
  }
  if (localAvailable === 0 && localUsed > 0) {
    addFactor('local_stock_occupied', '本仓现货已被占用', `发货仓可用 0，但现货占用数为 ${localUsed}。`, '核对占用订单是否可释放或调整库存分配。')
  }
  if (presaleRows > 0 || warningPresellNum > 0 || localPresaleOccupied > 0) {
    addFactor('presale_occupation', '预售占用可发库存', `缺货订单预售行 ${presaleRows}；预警预售量 ${warningPresellNum}；库存明细预售占用 ${localPresaleOccupied}。`, '核对预售到期、预售释放和锁库规则。')
  }
  if (containerInTransit) {
    const eta = toStringValue(row.container_eta_store)
    addFactor('container_in_transit', '关联预售货柜尚未到库', `关联货柜 ${toStringValue(row.sample_container_num)} 尚无实际到库时间${eta ? `，预计到库 ${eta}` : ''}。`, '跟进货柜到库与入库计划，并同步预售承诺。')
  }
  if (localAvailable === 0 && pendingShelvingTasks > 0) {
    addFactor('shelving_pending', '现货或预售上架任务未完成', `存在 ${pendingShelvingTasks} 个未完成上架任务${pendingTaskOwners ? `，责任人：${pendingTaskOwners}` : ''}。`, '优先跟进责任人完成上架，并复核库存同步。')
  }
  if (hasWarning && dealFlag === 0) {
    addFactor('warning_unhandled', '库存预警尚未处理', '存在最新有效库存预警，且仍未标记为已处理。', '处理库存预警并记录处理结果。')
  }
  if (!factors.length) {
    addFactor('genuine_shortage', '各仓当前均无可用库存', hasWarning
      ? '发货仓与其他仓均无可用量，对应库存预警已处理。'
      : '发货仓与其他仓均无可用量，且未查到有效库存预警。', hasWarning ? '安排补货并跟踪到货计划。' : '安排补货，并补建库存预警。')
  }

  const primaryOrder = [
    'local_stock_resolved', 'warehouse_allocation_gap', 'shelving_pending', 'container_in_transit',
    'local_stock_occupied', 'presale_occupation', 'warning_unhandled', 'genuine_shortage',
  ]
  const primary = primaryOrder.map(code => factors.find(factor => factor.code === code)).find(Boolean) || factors[0]
  const secondary = factors.filter(factor => factor !== primary)
  return {
    attribution: primary.code,
    attributionNote: primary.evidence,
    primaryAction: primary.action,
    contributingFactors: secondary,
    recommendedActions: [...new Set(factors.map(factor => factor.action))],
    confidence: containerInTransit || primary.code === 'genuine_shortage' ? 'medium' : 'high',
  }
}

function normalizeBySkuRow(row) {
  const common = {
    sku: toStringValue(row.sku),
    warehouseId: toInt(row.warehouse_id),
    warehouseName: toStringValue(row.warehouse_name),
    soldoutRows: toInt(row.soldout_rows),
    orderCount: toInt(row.order_count),
    quantitySum: toInt(row.quantity_sum),
    lastSoldoutTime: toStringValue(row.last_soldout_time),
    oldestShortageTime: toStringValue(row.oldest_shortage_time),
    soldoutStateRows: toInt(row.soldout_state_rows),
    processingRows: toInt(row.processing_rows),
    insufficientRows: toInt(row.insufficient_rows),
    presaleRows: toInt(row.presale_rows),
    occupiedRows: toInt(row.occupied_rows),
    shippedRows: toInt(row.shipped_rows),
    closedRows: toInt(row.closed_rows),
    sampleContainerNum: toStringValue(row.sample_container_num),
    containerCount: toInt(row.container_count),
    localAvailable: toInt(row.local_available),
    localUsednum: toInt(row.local_usednum),
    localStockStatus: toInt(row.local_stock_status),
    localStockUpdatedAt: toStringValue(row.local_stock_updated_at),
    localPresaleOccupied: toInt(row.local_presale_occupied),
    otherWarehouseAvailable: toInt(row.other_warehouse_available),
    transferCandidates: toStringValue(row.transfer_candidates),
    warningPresellNum: toInt(row.warning_presell_num),
    warningCriticalValue: toInt(row.warning_critical_value),
    warningDealFlag: toInt(row.warning_deal_flag),
    hasWarning: toInt(row.has_warning) === 1,
    warningCreateTime: toStringValue(row.warning_create_time),
    containerEtaStore: toStringValue(row.container_eta_store),
    containerAtaStore: toStringValue(row.container_ata_store),
    containerPresaleExpire: toStringValue(row.container_presale_expire),
    containerPresaleStatus: toInt(row.container_presale_status),
    containerLoadQty: toInt(row.container_load_qty),
    pendingShelvingTasks: toInt(row.pending_shelving_tasks),
    pendingTaskOwners: toStringValue(row.pending_task_owners),
    oldestShelvingTaskCreatedAt: toStringValue(row.oldest_shelving_task_created_at),
    shortageDays: toInt(row.shortage_days),
    overdueShipRows: toInt(row.overdue_ship_rows),
    earliestPlanPrintTime: toStringValue(row.earliest_plan_print_time),
  }
  return {
    ...common,
    evidence: {
      shortage: {
        oldestShortageTime: common.oldestShortageTime,
        lastSoldoutTime: common.lastSoldoutTime,
        shortageDays: common.shortageDays,
        soldoutStateRows: common.soldoutStateRows,
        processingRows: common.processingRows,
        insufficientRows: common.insufficientRows,
        presaleRows: common.presaleRows,
        overdueShipRows: common.overdueShipRows,
        earliestPlanPrintTime: common.earliestPlanPrintTime,
      },
      inventory: {
        localAvailable: common.localAvailable,
        localUsednum: common.localUsednum,
        localPresaleOccupied: common.localPresaleOccupied,
        localStockStatus: common.localStockStatus,
        localStockUpdatedAt: common.localStockUpdatedAt,
        otherWarehouseAvailable: common.otherWarehouseAvailable,
        transferCandidates: common.transferCandidates,
      },
      warning: {
        hasWarning: common.hasWarning,
        warningPresellNum: common.warningPresellNum,
        warningCriticalValue: common.warningCriticalValue,
        warningDealFlag: common.warningDealFlag,
        warningCreateTime: common.warningCreateTime,
      },
      container: {
        sampleContainerNum: common.sampleContainerNum,
        containerCount: common.containerCount,
        containerEtaStore: common.containerEtaStore,
        containerAtaStore: common.containerAtaStore,
        containerPresaleExpire: common.containerPresaleExpire,
        containerPresaleStatus: common.containerPresaleStatus,
        containerLoadQty: common.containerLoadQty,
      },
      shelving: {
        pendingShelvingTasks: common.pendingShelvingTasks,
        pendingTaskOwners: common.pendingTaskOwners,
        oldestShelvingTaskCreatedAt: common.oldestShelvingTaskCreatedAt,
      },
    },
    ...classifyAttribution(row),
  }
}

function normalizeByWarehouseRow(row) {
  return {
    warehouseId: toInt(row.warehouse_id),
    warehouseName: toStringValue(row.warehouse_name),
    skuCount: toInt(row.sku_count),
    soldoutRows: toInt(row.soldout_rows),
    orderCount: toInt(row.order_count),
    quantitySum: toInt(row.quantity_sum),
    lastSoldoutTime: toStringValue(row.last_soldout_time),
    soldoutStateRows: toInt(row.soldout_state_rows),
    processingRows: toInt(row.processing_rows),
    insufficientRows: toInt(row.insufficient_rows),
    presaleRows: toInt(row.presale_rows),
    occupiedRows: toInt(row.occupied_rows),
    shippedRows: toInt(row.shipped_rows),
    closedRows: toInt(row.closed_rows),
  }
}

function currentState(row, scope) {
  if (scope === 'active') return 'active'
  const total = Math.max(1, toInt(row.soldout_rows))
  const closed = toInt(row.shipped_rows) + toInt(row.closed_rows)
  if (closed >= total) return 'recovered_or_closed'
  return closed > 0 ? 'mixed' : 'active'
}

export function normalizeAttributionRows(rows, groupBy = 'sku', scope = 'active') {
  if (!Array.isArray(rows)) return []
  return groupBy === 'warehouse'
    ? rows.map(normalizeByWarehouseRow)
    : rows.map(row => ({ ...normalizeBySkuRow(row), currentState: currentState(row, scope) }))
}

const PRIORITY_WEIGHTS = Object.freeze({
  genuine_shortage: 90,
  container_in_transit: 80,
  shelving_pending: 75,
  warning_unhandled: 70,
  presale_occupation: 60,
  local_stock_occupied: 55,
  warehouse_allocation_gap: 45,
  local_stock_resolved: 10,
})

function priorityLevel(attribution) {
  const weight = PRIORITY_WEIGHTS[attribution] || 0
  if (weight >= 75) return 'P0'
  if (weight >= 60) return 'P1'
  if (weight >= 45) return 'P2'
  return 'P3'
}

function ageHours(value, now) {
  const timestamp = Date.parse(String(value || '').replace(' ', 'T'))
  if (!Number.isFinite(timestamp)) return 0
  return Math.max(0, Math.floor((now.getTime() - timestamp) / (60 * 60 * 1000)))
}

function joinOwners(...values) {
  return [...new Set(values
    .flatMap(value => toStringValue(value).split('、'))
    .map(value => value.trim())
    .filter(Boolean))].join('、')
}

function shortageTrend(shortageDays) {
  if (shortageDays >= 7) return '持续'
  if (shortageDays >= 3) return '反复'
  return '新近'
}

function impact(row, waitHours) {
  const overdueShipRows = toInt(row.overdueShipRows)
  const orderCount = toInt(row.orderCount)
  const quantitySum = toInt(row.quantitySum)
  if (overdueShipRows > 0 || waitHours >= 72) {
    return { level: 'critical', label: '紧急', score: 4, note: overdueShipRows > 0
      ? `已有 ${overdueShipRows} 行超过强制发货时间。`
      : `最早缺货已等待 ${waitHours} 小时。` }
  }
  if (orderCount >= 30 || quantitySum >= 50 || waitHours >= 24) {
    return { level: 'high', label: '高', score: 3, note: `影响 ${orderCount} 单 / ${quantitySum} 件${waitHours ? `，已等待 ${waitHours} 小时` : ''}。` }
  }
  if (orderCount >= 10 || quantitySum >= 15 || waitHours >= 8) {
    return { level: 'medium', label: '中', score: 2, note: `影响 ${orderCount} 单 / ${quantitySum} 件${waitHours ? `，已等待 ${waitHours} 小时` : ''}。` }
  }
  return { level: 'normal', label: '一般', score: 1, note: `影响 ${orderCount} 单 / ${quantitySum} 件。` }
}

function recovery(row, now) {
  const localAvailable = toInt(row.localAvailable)
  const pendingTasks = toInt(row.pendingShelvingTasks)
  const taskWaitHours = ageHours(row.oldestShelvingTaskCreatedAt, now)
  const containerInTransit = toInt(row.containerPresaleStatus) === 1 && !row.containerAtaStore
  if (localAvailable > 0) {
    return {
      status: 'stock_ready', eta: '', pendingShelvingHours: taskWaitHours,
      basis: `发货仓当前已有可用库存 ${localAvailable}，应优先核对推仓、拣货或打单。`,
    }
  }
  if (containerInTransit) {
    const eta = row.containerEtaStore
    const quantity = toInt(row.containerLoadQty)
    return {
      status: 'container_in_transit', eta, pendingShelvingHours: taskWaitHours,
      basis: `关联货柜尚未实际到库${quantity ? `，该 SKU 装柜量 ${quantity}` : ''}。`,
    }
  }
  if (pendingTasks > 0) {
    return {
      status: 'shelving_pending', eta: '', pendingShelvingHours: taskWaitHours,
      basis: `存在 ${pendingTasks} 个未完成上架任务${taskWaitHours ? `，最早已等待 ${taskWaitHours} 小时` : ''}。`,
    }
  }
  return { status: 'unknown', eta: '', pendingShelvingHours: taskWaitHours, basis: '当前表中没有可确认的到货或上架完成时间。' }
}

function summarize(rows, key, label) {
  const groups = new Map()
  for (const row of rows) {
    const value = key(row) || '未分配'
    const item = groups.get(value) || { [label]: value, groups: 0, orderCount: 0, quantitySum: 0 }
    item.groups += 1
    item.orderCount += toInt(row.orderCount)
    item.quantitySum += toInt(row.quantitySum)
    groups.set(value, item)
  }
  return [...groups.values()].sort((left, right) => right.quantitySum - left.quantitySum || right.orderCount - left.orderCount)
}

export function buildAttributionActionSummary(rows = [], groupBy = 'sku', now = new Date()) {
  if (groupBy !== 'sku') {
    return { scope: 'returned_rows', byReason: [], byWarehouse: [], byOwner: [], byImpact: [], byTrend: [] }
  }
  const queue = rows.map(row => {
    const waitHours = ageHours(row.oldestShortageTime, now)
    const impactResult = impact(row, waitHours)
    const recoveryResult = recovery(row, now)
    const owners = joinOwners(row.pendingTaskOwners)
    const score = ((PRIORITY_WEIGHTS[row.attribution] || 0) * 1000000)
      + (impactResult.score * 10000)
      + (Math.min(waitHours, 9999) * 100)
      + Math.min(toInt(row.quantitySum), 99)
    return {
      ...row,
      waitHours,
      shortageTrend: shortageTrend(toInt(row.shortageDays)),
      impactLevel: impactResult.level,
      impactLabel: impactResult.label,
      impactNote: impactResult.note,
      recoveryStatus: recoveryResult.status,
      recoveryEta: recoveryResult.eta,
      recoveryBasis: recoveryResult.basis,
      pendingShelvingHours: recoveryResult.pendingShelvingHours,
      responsibleOwners: owners,
      priority: priorityLevel(row.attribution),
      priorityScore: score,
    }
  }).sort((left, right) => right.priorityScore - left.priorityScore || right.quantitySum - left.quantitySum)
  return {
    scope: 'returned_rows',
    byReason: summarize(queue, row => ATTRIBUTION_LABELS[row.attribution] || row.attribution, 'reason'),
    byWarehouse: summarize(queue, row => `${row.warehouseName}(${row.warehouseId})`, 'warehouse'),
    byOwner: summarize(queue, row => row.responsibleOwners, 'owner'),
    byImpact: summarize(queue, row => row.impactLabel, 'impact'),
    byTrend: summarize(queue, row => row.shortageTrend, 'trend'),
    queue,
  }
}

/** 只读执行缺货归因；查询超时、取消沿用连接层的统一处理。 */
export async function runSoldoutAttribution(config, input = {}, {
  createConnection,
  signal,
  now = () => new Date(),
} = {}) {
  const params = normalizeAttributionParams(input)
  const built = buildSoldoutAttributionQuery(params)
  const [rows] = await runDatabaseOperation(
    config,
    connection => connection.execute(built.sql, built.values),
    { createConnection, signal, timeoutMs: resolveSecurityPolicy(config).queryTimeoutMs },
  )
  const normalized = maskSensitiveRows(normalizeAttributionRows(rows, params.group_by, params.scope), config)
  const actionSummary = buildAttributionActionSummary(normalized, params.group_by, now())
  return {
    windowDays: params.window_days,
    timeRange: built.meta.timeRange,
    groupBy: params.group_by,
    scope: params.scope,
    generatedAt: formatLocalDateTime(now()),
    groups: normalized.length,
    actionSummary: {
      scope: actionSummary.scope,
      byReason: actionSummary.byReason,
      byWarehouse: actionSummary.byWarehouse,
      byOwner: actionSummary.byOwner,
      byImpact: actionSummary.byImpact,
      byTrend: actionSummary.byTrend,
    },
    rows: actionSummary.queue || normalized,
  }
}
