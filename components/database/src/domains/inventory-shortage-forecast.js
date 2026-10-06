/**
 * 预测性缺货预警。
 *
 * 只读取当前自然月预测与当前库存，不扫描订单明细；它回答“尚未缺货但即将断货”的问题，
 * 与 database_soldout_attribution 的“已经缺货，为什么缺”严格分工。
 */
import { runDatabaseOperation } from './connection.js'
import { formatLocalDateTime } from './format.js'
import { resolveSecurityPolicy } from '../security/policy.js'
import { maskSensitiveRows } from '../security/sensitive-fields.js'

const PREDICT_TABLE = 'report_t_predict_sku'
const INVENTORY_TABLE = 'oms_t_inventory'

export const INVENTORY_SHORTAGE_FORECAST_TABLES = Object.freeze([PREDICT_TABLE, INVENTORY_TABLE])
export const DEFAULT_FORECAST_TOP_N = 20
export const MAX_FORECAST_TOP_N = 500
export const DEFAULT_COVERAGE_DAYS = 14
export const MAX_COVERAGE_DAYS = 90

const ALLOWED_PARAMS = new Set(['warehouse_id', 'top_n', 'coverage_days'])

function toInt(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : 0
}

function toStringValue(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

function positiveInteger(value, label, { minimum, maximum }) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 之间的整数。`)
  }
  return number
}

export function normalizeInventoryShortageForecastParams(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('预测性缺货预警参数无效。')
  const unknown = Object.keys(input).filter(key => !ALLOWED_PARAMS.has(key))
  if (unknown.length) throw new Error(`预测性缺货预警不支持参数：${unknown.join('、')}。`)
  return {
    warehouse_id: input.warehouse_id === undefined || input.warehouse_id === null
      ? null
      : positiveInteger(input.warehouse_id, 'warehouse_id', { minimum: 1, maximum: 2147483647 }),
    top_n: input.top_n === undefined || input.top_n === null
      ? DEFAULT_FORECAST_TOP_N
      : positiveInteger(input.top_n, 'top_n', { minimum: 1, maximum: MAX_FORECAST_TOP_N }),
    coverage_days: input.coverage_days === undefined || input.coverage_days === null
      ? DEFAULT_COVERAGE_DAYS
      : positiveInteger(input.coverage_days, 'coverage_days', { minimum: 1, maximum: MAX_COVERAGE_DAYS }),
  }
}

/** 固定聚合查询：MySQL 先按 SKU×仓库汇总预测和库存，再仅返回覆盖天数低于阈值的分组。 */
export function buildInventoryShortageForecastQuery(input = {}) {
  const params = normalizeInventoryShortageForecastParams(input)
  const hasWarehouseFilter = params.warehouse_id !== null
  const warehouseFilter = hasWarehouseFilter ? ' AND warehouse_id = ?' : ''
  const sql = `
SELECT
  forecast.sku,
  forecast.warehouse_id,
  COALESCE(local_stock.warehouse_name, '') AS warehouse_name,
  DATE_FORMAT(CURDATE(), '%Y-%m') AS forecast_month,
  forecast.monthly_forecast_qty,
  GREATEST(1, CEIL(forecast.monthly_forecast_qty / 30)) AS forecast_daily_qty,
  CAST(COALESCE(local_stock.local_available, 0) AS SIGNED) AS local_available,
  CAST(COALESCE(local_stock.local_usednum, 0) AS SIGNED) AS local_usednum,
  COALESCE(local_stock.local_stock_status, 9) AS local_stock_status,
  DATE_FORMAT(local_stock.local_stock_updated_at, '%Y-%m-%d %H:%i:%s') AS local_stock_updated_at,
  COALESCE(forecast.forecast_owners, '') AS forecast_owners,
  CAST(COALESCE((
    SELECT SUM(other_inventory.available)
    FROM ${INVENTORY_TABLE} other_inventory
    WHERE other_inventory.p_sku = forecast.sku
      AND other_inventory.wsid <> forecast.warehouse_id
      AND other_inventory.available > 0
  ), 0) AS SIGNED) AS other_warehouse_available,
  COALESCE((
    SELECT LEFT(GROUP_CONCAT(CONCAT(other_inventory.wsname, '(', other_inventory.wsid, '):', other_inventory.available)
      ORDER BY other_inventory.available DESC SEPARATOR '、'), 500)
    FROM ${INVENTORY_TABLE} other_inventory
    WHERE other_inventory.p_sku = forecast.sku
      AND other_inventory.wsid <> forecast.warehouse_id
      AND other_inventory.available > 0
  ), '') AS transfer_candidates
FROM (
  SELECT
    sku,
    warehouse_id,
    CAST(SUM(COALESCE(num, 0)) AS SIGNED) AS monthly_forecast_qty,
    LEFT(GROUP_CONCAT(DISTINCT NULLIF(duty_user_name, '') ORDER BY duty_user_name SEPARATOR '、'), 300) AS forecast_owners
  FROM ${PREDICT_TABLE}
  WHERE COALESCE(is_delete, 0) = 0
    AND CAST(predict_year AS UNSIGNED) = YEAR(CURDATE())
    AND CAST(predict_month AS UNSIGNED) = MONTH(CURDATE())${warehouseFilter}
  GROUP BY sku, warehouse_id
) forecast
LEFT JOIN (
  SELECT
    p_sku,
    wsid,
    MAX(NULLIF(wsname, '')) AS warehouse_name,
    CAST(SUM(COALESCE(available, 0)) AS SIGNED) AS local_available,
    CAST(SUM(COALESCE(usednum, 0)) AS SIGNED) AS local_usednum,
    MAX(status) AS local_stock_status,
    MAX(update_time) AS local_stock_updated_at
  FROM ${INVENTORY_TABLE}
  GROUP BY p_sku, wsid
) local_stock ON local_stock.p_sku = forecast.sku AND local_stock.wsid = forecast.warehouse_id
WHERE forecast.monthly_forecast_qty > 0
  AND FLOOR(COALESCE(local_stock.local_available, 0) / NULLIF(GREATEST(1, CEIL(forecast.monthly_forecast_qty / 30)), 0)) < ?
ORDER BY
  FLOOR(COALESCE(local_stock.local_available, 0) / NULLIF(GREATEST(1, CEIL(forecast.monthly_forecast_qty / 30)), 0)) ASC,
  forecast.monthly_forecast_qty DESC
LIMIT ?`
  return {
    sql: sql.trim(),
    values: [...(hasWarehouseFilter ? [params.warehouse_id] : []), params.coverage_days, params.top_n],
    meta: { hasWarehouseFilter, coverageDays: params.coverage_days, appliedLimit: params.top_n },
  }
}

function riskFor(coverageDays) {
  if (coverageDays <= 0) return { level: 'critical', label: '即将断货', action: '立即核实可用库存、调拨与补货计划。' }
  if (coverageDays < 7) return { level: 'high', label: '高风险', action: '优先安排补货或调拨，并确认到货与上架时间。' }
  return { level: 'medium', label: '中风险', action: '纳入近期补货计划并持续跟踪库存覆盖。' }
}

export function normalizeInventoryShortageForecastRows(rows, coverageDays) {
  if (!Array.isArray(rows)) return []
  return rows.map(row => {
    const monthlyForecastQty = toInt(row.monthly_forecast_qty)
    const forecastDailyQty = Math.max(1, toInt(row.forecast_daily_qty))
    const localAvailable = toInt(row.local_available)
    const stockCoverDays = Math.floor(Math.max(0, localAvailable) / forecastDailyQty)
    const risk = riskFor(stockCoverDays)
    return {
      sku: toStringValue(row.sku),
      warehouseId: toInt(row.warehouse_id),
      warehouseName: toStringValue(row.warehouse_name),
      forecastMonth: toStringValue(row.forecast_month),
      monthlyForecastQty,
      forecastDailyQty,
      localAvailable,
      localUsednum: toInt(row.local_usednum),
      localStockStatus: toInt(row.local_stock_status),
      localStockUpdatedAt: toStringValue(row.local_stock_updated_at),
      stockCoverDays,
      coverageThresholdDays: coverageDays,
      shortfallQty: Math.max(0, (coverageDays * forecastDailyQty) - localAvailable),
      otherWarehouseAvailable: toInt(row.other_warehouse_available),
      transferCandidates: toStringValue(row.transfer_candidates),
      forecastOwners: toStringValue(row.forecast_owners),
      riskLevel: risk.level,
      riskLabel: risk.label,
      recommendedAction: risk.action,
    }
  })
}

function summarize(rows, key, label) {
  const groups = new Map()
  for (const row of rows) {
    const value = key(row) || '未分配'
    const item = groups.get(value) || { [label]: value, groups: 0, monthlyForecastQty: 0, shortfallQty: 0 }
    item.groups += 1
    item.monthlyForecastQty += row.monthlyForecastQty
    item.shortfallQty += row.shortfallQty
    groups.set(value, item)
  }
  return [...groups.values()].sort((left, right) => right.shortfallQty - left.shortfallQty || right.monthlyForecastQty - left.monthlyForecastQty)
}

export async function runInventoryShortageForecast(config, input = {}, {
  createConnection,
  signal,
  now = () => new Date(),
} = {}) {
  const params = normalizeInventoryShortageForecastParams(input)
  const built = buildInventoryShortageForecastQuery(params)
  const [rows] = await runDatabaseOperation(
    config,
    connection => connection.execute(built.sql, built.values),
    { createConnection, signal, timeoutMs: resolveSecurityPolicy(config).queryTimeoutMs },
  )
  const normalized = maskSensitiveRows(normalizeInventoryShortageForecastRows(rows, params.coverage_days), config)
  return {
    forecastMonth: formatLocalDateTime(now()).slice(0, 7),
    coverageThresholdDays: params.coverage_days,
    groups: normalized.length,
    summary: {
      byRisk: summarize(normalized, row => row.riskLabel, 'risk'),
      byWarehouse: summarize(normalized, row => `${row.warehouseName}(${row.warehouseId})`, 'warehouse'),
      byOwner: summarize(normalized, row => row.forecastOwners, 'owner'),
    },
    rows: normalized,
  }
}
