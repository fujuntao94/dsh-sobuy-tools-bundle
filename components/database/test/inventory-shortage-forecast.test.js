import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dshToolValueViolations } from 'sobuy-plugin-core/schema'
import {
  INVENTORY_SHORTAGE_FORECAST_TABLES,
  buildInventoryShortageForecastQuery,
  normalizeInventoryShortageForecastParams,
  normalizeInventoryShortageForecastRows,
  runInventoryShortageForecast,
} from '../src/domains/inventory-shortage-forecast.js'
import { createInventoryShortageForecastTool, registerInventoryShortageForecastTool } from '../src/runtime/tools/inventory-shortage-forecast-tool.js'
import { registerInventoryShortageForecastSkill } from '../src/runtime/skills/inventory-shortage-forecast-skill.js'
import { writePrivateConfig } from '../src/storage/config-store.js'

const CONFIG = { type: 'mysql', host: 'db.internal', port: 3306, database: 'sobuy-oms', username: 'readonly', password: 'secret', ssl: false, allowedTables: [], maxRows: 100, queryTimeoutMs: 5000 }
const ROW = {
  sku: 'FRG225-W', warehouse_id: 50, warehouse_name: 'HS-A', forecast_month: '2026-10',
  monthly_forecast_qty: 300, forecast_daily_qty: 10, local_available: 20, local_usednum: 5,
  local_stock_status: 1, local_stock_updated_at: '2026-10-06 10:00:00', other_warehouse_available: 80,
  transfer_candidates: 'DE(20):80', forecast_owners: '李四',
}

test('预测性缺货预警只接受受控参数，并只聚合预测和库存表', () => {
  assert.deepEqual(normalizeInventoryShortageForecastParams({}), { warehouse_id: null, top_n: 500, coverage_days: 14 })
  assert.throws(() => normalizeInventoryShortageForecastParams({ sql: 'SELECT 1' }), /不支持参数/)
  assert.throws(() => normalizeInventoryShortageForecastParams({ coverage_days: 91 }), /coverage_days必须是 1 到 90/)
  assert.throws(() => normalizeInventoryShortageForecastParams({ top_n: 1001 }), /top_n必须是 1 到 1000/)
  const built = buildInventoryShortageForecastQuery({ warehouse_id: 50, coverage_days: 14, top_n: 3 })
  assert.match(built.sql, /^SELECT\b/)
  assert.equal(built.sql.includes(';'), false)
  assert.doesNotMatch(built.sql, /oms_t_orders_tracking|\b(UPDATE|DELETE|INSERT|DROP)\b/i)
  for (const table of INVENTORY_SHORTAGE_FORECAST_TABLES) assert.match(built.sql, new RegExp(`\\b${table}\\b`))
  assert.deepEqual(built.values, [50, 14, 3])
  assert.match(built.sql, /forecast\.monthly_forecast_qty > 0/)
  assert.match(built.sql, /GROUP BY sku, warehouse_id/)
  assert.match(built.sql, /FLOOR\(COALESCE\(local_stock\.local_available, 0\)/)
  assert.match(built.sql, /FROM \(\n  SELECT\n    forecast\.sku/)
  assert.match(built.sql, /\) risk$/)
})

test('预测行计算库存覆盖、缺口和风险等级', () => {
  const row = normalizeInventoryShortageForecastRows([ROW], 14)[0]
  assert.equal(row.stockCoverDays, 2)
  assert.equal(row.shortfallQty, 120)
  assert.equal(row.riskLevel, 'high')
  assert.match(row.recommendedAction, /补货或调拨/)
})

test('预测 Tool 只执行固定只读聚合并返回详细预警', async () => {
  const calls = []
  const result = await runInventoryShortageForecast(CONFIG, { coverage_days: 14 }, {
    createConnection: async () => ({
      execute: async (sql, values) => { calls.push({ sql, values }); return [[ROW]] },
      end: async () => {},
    }),
    now: () => new Date(2026, 9, 6, 16, 40, 0),
  })
  assert.deepEqual(calls[0].values, [14, 500])
  assert.equal(result.rows[0].riskLabel, '高风险')
  assert.equal(result.summary.byRisk[0].shortfallQty, 120)

  const folder = await mkdtemp(join(tmpdir(), 'dsh-database-forecast-'))
  try {
    await writePrivateConfig(CONFIG, folder)
    const tool = createInventoryShortageForecastTool({ dataDirectory: folder, forecast: async () => result })
    const value = await tool.execute({}, { signal: new AbortController().signal })
    assert.equal(tool.name, 'database_inventory_shortage_forecast')
    assert.deepEqual(dshToolValueViolations(tool.output.schema, value), [])
    assert.match(tool.output.render({}, value)[0].text, /预测性缺货预警/)
    assert.match(tool.output.render({}, value)[0].text, /覆盖阈值 14 天/)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('预测 Tool 可通过 DSH 运行时注册', () => {
  const tools = []
  registerInventoryShortageForecastTool({ tools: { register: definition => { tools.push(definition); return () => {} } } }, {})
  assert.deepEqual(tools.map(tool => tool.name), ['database_inventory_shortage_forecast'])
})

test('预测性缺货预警 Skill 可通过 DSH 运行时注册，并明确区分已缺货归因', () => {
  const skills = []
  registerInventoryShortageForecastSkill({ skills: { register: definition => { skills.push(definition); return () => {} } } })
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'database-inventory-shortage-forecast')
  assert.equal(skills[0].source, 'bundled')
  assert.deepEqual(skills[0].invocation, { modelInvocable: true, userInvocable: true })
  assert.match(skills[0].content, /database_inventory_shortage_forecast/)
  assert.match(skills[0].content, /database_soldout_attribution/)
  assert.match(skills[0].content, /不是采购、到货或履约承诺/)
  assert.match(skills[0].content, /输出要求/)
  assert.match(skills[0].content, /当前没有库存覆盖低于 N 天的 SKU×仓库分组/)
  assert.equal(skills[0].content.startsWith('---'), false)
})
