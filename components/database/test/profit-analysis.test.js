import assert from 'node:assert/strict'
import test from 'node:test'
import { dshToolValueViolations } from 'sobuy-plugin-core/schema'
import { buildProfitAnalysisQuery, normalizeProfitAnalysisParams, runProfitAnalysis } from '../src/domains/profit-analysis.js'
import { createProfitAnalysisTool } from '../src/runtime/tools/profit-analysis-tool.js'

const config = { host: 'db.internal', port: 3306, database: 'sobuy-oms', username: 'readonly', password: 'secret', queryTimeoutMs: 5000 }
const source = { group_key: 'DE', net_sales: '100', gross_sales: '120', gross_profit: '40', net_profit: '-5', quantity: 10, refund_amount: 2, actual_shipping: 8, advertising_fee_share: 4 }
test('利润分析只接受固定月份、维度和筛选，SQL 不含写入入口', () => {
  assert.deepEqual(normalizeProfitAnalysisParams({ month: '2026-10' }).currency, 'EUR')
  assert.throws(() => normalizeProfitAnalysisParams({ month: '2026-13' }), /YYYY-MM/)
  assert.throws(() => normalizeProfitAnalysisParams({ month: '2026-10', sql: 'select 1' }), /不支持参数/)
  const built = buildProfitAnalysisQuery({ month: '2026-10', group_by: 'country', country: 'DE', top_n: 3 })
  assert.match(built.sql, /^SELECT/); assert.doesNotMatch(built.sql, /;|\b(?:UPDATE|DELETE|INSERT|DROP)\b/i)
  assert.deepEqual(built.values, ['2026-10-01', '2026-10-01', 'DE', 3])
})
test('利润分析聚合已沉淀利润字段并通过工具 schema', async () => {
  const result = await runProfitAnalysis(config, { month: '2026-10', group_by: 'country' }, { createConnection: async () => ({ execute: async () => [[source]], end: async () => {} }) })
  assert.equal(result.rows[0].netProfit, -5); assert.equal(result.rows[0].netMargin, -0.05); assert.equal(result.summary.allocatedFees, 4)
  const tool = createProfitAnalysisTool({ analysis: async () => result })
  assert.deepEqual(dshToolValueViolations(tool.output.schema, result), [])
  assert.match(tool.output.render({}, result)[0].text, /净利率/)
})
