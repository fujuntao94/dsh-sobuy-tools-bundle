import { runDatabaseOperation } from './connection.js'

const MAX_TOP_PRODUCTS = 10
const MAX_DESTINATIONS = 8
const ALLOWED = new Set(['customer_id'])

function customerId(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('客户画像参数无效。')
  const unknown = Object.keys(input).filter(key => !ALLOWED.has(key))
  if (unknown.length) throw new Error(`客户画像不支持参数：${unknown.join('、')}。`)
  const value = String(input.customer_id || '').trim()
  if (!value || value.length > 50 || /[\0-\x1f\x7f]/.test(value)) throw new Error('customer_id无效。')
  return value
}

export function buildCustomerProfileQueries(input = {}) {
  const id = customerId(input)
  return {
    customerId: id,
    summary: {
      sql: `SELECT
        cust_id AS customer_id, MAX(cust_account) AS customer_account, MAX(cust_petname) AS nickname,
        MAX(cust_email) AS email, MAX(ship_name) AS recipient_name, MAX(ship_tel) AS phone,
        MAX(ship_country) AS shipping_country, MAX(ship_city) AS shipping_city,
        MAX(is_encryption) AS is_encryption, MIN(order_time) AS first_order_at, MAX(order_time) AS last_order_at,
        COUNT(DISTINCT order_id) AS order_count,
        SUM(CASE WHEN has_after_sale = 1 THEN 1 ELSE 0 END) AS after_sale_order_count,
        SUM(CASE WHEN customer_cancel_flag > 0 THEN 1 ELSE 0 END) AS cancellation_intent_count,
        MAX(is_regular_customer) AS is_regular_customer
      FROM oms_t_orders
      WHERE cust_id = ? AND valid = 1
      GROUP BY cust_id
      LIMIT 1`,
      values: [id],
    },
    spending: {
      sql: `SELECT COALESCE(currency, '未设置') AS currency,
        CAST(SUM(CASE WHEN order_source = 0 AND pay_status = 1 THEN COALESCE(paid_price, 0) ELSE 0 END) AS DECIMAL(19,4)) AS paid_amount,
        CAST(SUM(COALESCE(refund, 0)) AS DECIMAL(19,4)) AS refund_amount
      FROM oms_t_orders
      WHERE cust_id = ? AND valid = 1
      GROUP BY COALESCE(currency, '未设置')
      ORDER BY currency ASC`,
      values: [id],
    },
    products: {
      sql: `SELECT p.p_sku AS sku, MAX(p.p_name) AS name, SUM(COALESCE(p.quantity, 0)) AS quantity,
        COUNT(DISTINCT p.order_id) AS order_count
      FROM oms_t_orders o
      INNER JOIN oms_t_orders_product p ON p.order_id = o.order_id AND p.valid = 1
      WHERE o.cust_id = ? AND o.valid = 1
      GROUP BY p.p_sku
      ORDER BY quantity DESC, order_count DESC, p.p_sku ASC
      LIMIT ?`,
      values: [id, MAX_TOP_PRODUCTS],
    },
    destinations: {
      sql: `SELECT COALESCE(t.cust_country, o.ship_country, '未设置') AS country,
        COUNT(DISTINCT o.order_id) AS order_count,
        SUM(CASE WHEN t.received_time IS NOT NULL THEN 1 ELSE 0 END) AS received_count,
        SUM(CASE WHEN t.exception_time IS NOT NULL THEN 1 ELSE 0 END) AS exception_count
      FROM oms_t_orders o
      LEFT JOIN oms_t_orders_tracking t ON t.order_id = o.order_id AND t.valid = 1
      WHERE o.cust_id = ? AND o.valid = 1
      GROUP BY COALESCE(t.cust_country, o.ship_country, '未设置')
      ORDER BY order_count DESC, country ASC
      LIMIT ?`,
      values: [id, MAX_DESTINATIONS],
    },
  }
}

const number = value => Number.isFinite(Number(value)) ? Number(value) : 0
const text = value => value == null || value === '' ? null : String(value)
const time = value => value instanceof Date ? value.toISOString() : text(value)

export async function queryCustomerProfile(config, input, { createConnection, signal } = {}) {
  const queries = buildCustomerProfileQueries(input)
  const [summaryRows, spendingRows, productRows, destinationRows] = await runDatabaseOperation(config, async connection => Promise.all([
    connection.execute(queries.summary.sql, queries.summary.values),
    connection.execute(queries.spending.sql, queries.spending.values),
    connection.execute(queries.products.sql, queries.products.values),
    connection.execute(queries.destinations.sql, queries.destinations.values),
  ]), { createConnection, signal, timeoutMs: 10000 })
  const summary = summaryRows[0][0]
  if (!summary) return null
  return {
    raw: summary,
    spending: spendingRows[0].map(row => ({ currency: text(row.currency) || '未设置', paidAmount: number(row.paid_amount), refundAmount: number(row.refund_amount) })),
    products: productRows[0].map(row => ({ sku: text(row.sku) || '未设置', name: text(row.name), quantity: number(row.quantity), orderCount: number(row.order_count) })),
    destinations: destinationRows[0].map(row => ({ country: text(row.country) || '未设置', orderCount: number(row.order_count), receivedCount: number(row.received_count), exceptionCount: number(row.exception_count) })),
    metrics: {
      firstOrderAt: time(summary.first_order_at), lastOrderAt: time(summary.last_order_at), orderCount: number(summary.order_count),
      afterSaleOrderCount: number(summary.after_sale_order_count),
      cancellationIntentCount: number(summary.cancellation_intent_count), regularCustomer: Number(summary.is_regular_customer) === 1,
    },
  }
}
