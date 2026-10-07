/** 经营利润分析：只读固定聚合，不向模型开放 SQL、表名或列名。 */
import { runDatabaseOperation } from './connection.js'
import { resolveSecurityPolicy } from '../security/policy.js'
import { maskSensitiveRows } from '../security/sensitive-fields.js'

const FACT_TABLE = 'report_t_sub_order'
export const PROFIT_ANALYSIS_TABLES = Object.freeze([FACT_TABLE])
export const DEFAULT_PROFIT_TOP_N = 20
export const MAX_PROFIT_TOP_N = 200
const CURRENCIES = new Set(['EUR', 'USD', 'CNY'])
const DIMENSIONS = Object.freeze({
  platform: { expression: "COALESCE(platform, '未设置')", label: '平台' },
  country: { expression: "COALESCE(country, '未设置')", label: '站点' },
  warehouse: { expression: "COALESCE(warehouse_name, '未设置')", label: '仓库' },
  owner: { expression: "COALESCE(duty_user_name, '未设置')", label: '责任人' },
  sku: { expression: "COALESCE(sku, '未设置')", label: 'SKU' },
  product_line: { expression: "COALESCE(product_line, '未设置')", label: '产品线' },
})
const ALLOWED = new Set(['month', 'currency', 'group_by', 'platform_id', 'country', 'duty_id', 'group_id', 'warehouse_id', 'sku', 'product_line', 'top_n'])

function positive(value, label, maximum) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > maximum) throw new Error(`${label}必须是 1 到 ${maximum} 之间的整数。`)
  return n
}
function optionalText(value, label) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!text || text.length > 64 || /[\0-\x1f\x7f]/.test(text)) throw new Error(`${label}无效。`)
  return text
}
export function normalizeProfitAnalysisParams(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('利润分析参数无效。')
  const unknown = Object.keys(input).filter(key => !ALLOWED.has(key))
  if (unknown.length) throw new Error(`利润分析不支持参数：${unknown.join('、')}。`)
  const month = String(input.month || '').trim()
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('month必须是 YYYY-MM 格式。')
  const currency = String(input.currency || 'EUR').toUpperCase()
  if (!CURRENCIES.has(currency)) throw new Error('currency仅支持 EUR、USD 或 CNY。')
  const group_by = input.group_by || 'platform'
  if (!Object.hasOwn(DIMENSIONS, group_by)) throw new Error(`group_by仅支持：${Object.keys(DIMENSIONS).join('、')}。`)
  return {
    month, currency, group_by,
    platform_id: input.platform_id == null ? null : positive(input.platform_id, 'platform_id', 2147483647),
    duty_id: input.duty_id == null ? null : positive(input.duty_id, 'duty_id', 2147483647),
    group_id: input.group_id == null ? null : positive(input.group_id, 'group_id', 2147483647),
    warehouse_id: input.warehouse_id == null ? null : positive(input.warehouse_id, 'warehouse_id', 2147483647),
    country: optionalText(input.country, 'country'), sku: optionalText(input.sku, 'sku'), product_line: optionalText(input.product_line, 'product_line'),
    top_n: input.top_n == null ? DEFAULT_PROFIT_TOP_N : positive(input.top_n, 'top_n', MAX_PROFIT_TOP_N),
  }
}
export function buildProfitAnalysisQuery(input = {}) {
  const p = normalizeProfitAnalysisParams(input)
  const dim = DIMENSIONS[p.group_by]
  const conditions = ['COALESCE(is_delete, 0) = 0', 'pay_date >= ?', 'pay_date < DATE_ADD(?, INTERVAL 1 MONTH)']
  const values = [`${p.month}-01`, `${p.month}-01`]
  for (const [field, value] of Object.entries({ platform_id: p.platform_id, country: p.country, duty_id: p.duty_id, group_id: p.group_id, warehouse_id: p.warehouse_id, sku: p.sku, product_line: p.product_line })) {
    if (value !== null) { conditions.push(`${field} = ?`); values.push(value) }
  }
  const suffix = p.currency.toLowerCase()
  const fees = ['store_rent_share', 'commission_share', 'pallet_fee_share', 'advertising_fee_share', 'storage_fee_share', 'fba_return_cost_share', 'amazon_manager_fee_share', 'transfer_fee_share', 'ocean_freight_share', 'wharf_to_warehouse_share', 'warehouse_labour_share']
  const feeSql = fees.map(field => `SUM(COALESCE(${field}, 0)) AS ${field}`).join(',\n  ')
  return { params: p, sql: `SELECT\n  ${dim.expression} AS group_key,\n  CAST(SUM(COALESCE(net_amount_${suffix}, 0)) AS DECIMAL(19,4)) AS net_sales,\n  CAST(SUM(COALESCE(gross_amount_${suffix}, 0)) AS DECIMAL(19,4)) AS gross_sales,\n  CAST(SUM(COALESCE(gross_profit_${suffix}, 0)) AS DECIMAL(19,4)) AS gross_profit,\n  CAST(SUM(COALESCE(net_profit_${suffix}, 0)) AS DECIMAL(19,4)) AS net_profit,\n  CAST(SUM(COALESCE(quantity, 0)) AS SIGNED) AS quantity,\n  CAST(SUM(COALESCE(refund_amount, 0)) AS DECIMAL(19,4)) AS refund_amount,\n  CAST(SUM(COALESCE(true_ship_price, 0)) AS DECIMAL(19,4)) AS actual_shipping,\n  ${feeSql}\nFROM ${FACT_TABLE}\nWHERE ${conditions.join(' AND ')}\nGROUP BY ${dim.expression}\nORDER BY net_profit ASC\nLIMIT ?`, values: [...values, p.top_n] }
}
function n(value) { const x = Number(value); return Number.isFinite(x) ? x : 0 }
function row(raw) {
  const netSales = n(raw.net_sales), netProfit = n(raw.net_profit), grossProfit = n(raw.gross_profit)
  const feeFields = ['store_rent_share', 'commission_share', 'pallet_fee_share', 'advertising_fee_share', 'storage_fee_share', 'fba_return_cost_share', 'amazon_manager_fee_share', 'transfer_fee_share', 'ocean_freight_share', 'wharf_to_warehouse_share', 'warehouse_labour_share']
  const feeTotal = feeFields.reduce((total, field) => total + n(raw[field]), 0)
  return { group: String(raw.group_key || '未设置'), netSales, grossSales: n(raw.gross_sales), grossProfit, netProfit, quantity: n(raw.quantity), refundAmount: n(raw.refund_amount), actualShipping: n(raw.actual_shipping), allocatedFees: feeTotal, grossMargin: netSales ? grossProfit / netSales : null, netMargin: netSales ? netProfit / netSales : null }
}
export async function runProfitAnalysis(config, input = {}, { createConnection, signal } = {}) {
  const built = buildProfitAnalysisQuery(input)
  const [rows] = await runDatabaseOperation(config, c => c.execute(built.sql, built.values), { createConnection, signal, timeoutMs: resolveSecurityPolicy(config).queryTimeoutMs })
  const normalized = maskSensitiveRows(rows.map(row), config)
  const totals = normalized.reduce((sum, item) => ({ netSales: sum.netSales + item.netSales, grossProfit: sum.grossProfit + item.grossProfit, netProfit: sum.netProfit + item.netProfit, quantity: sum.quantity + item.quantity, refundAmount: sum.refundAmount + item.refundAmount, allocatedFees: sum.allocatedFees + item.allocatedFees }), { netSales: 0, grossProfit: 0, netProfit: 0, quantity: 0, refundAmount: 0, allocatedFees: 0 })
  return { month: built.params.month, currency: built.params.currency, groupBy: built.params.group_by, groupLabel: DIMENSIONS[built.params.group_by].label, rows: normalized, groups: normalized.length, summary: { ...totals, grossMargin: totals.netSales ? totals.grossProfit / totals.netSales : null, netMargin: totals.netSales ? totals.netProfit / totals.netSales : null }, note: '按付款日期统计；净利润、毛利润和销售额直接使用报表事实表的已沉淀字段，费用分摊仅作构成展示，不能再次从净利润扣减。' }
}
