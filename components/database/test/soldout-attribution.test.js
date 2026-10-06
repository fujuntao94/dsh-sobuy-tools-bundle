import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dshToolValueViolations } from 'sobuy-plugin-core/schema'
import {
  MAX_WINDOW_DAYS,
  SOLD_OUT_ATTRIBUTION_TABLES,
  buildAttributionActionSummary,
  buildSoldoutAttributionQuery,
  classifyAttribution,
  normalizeAttributionParams,
  normalizeAttributionRows,
  runSoldoutAttribution,
} from '../src/domains/soldout-attribution.js'
import { createSoldoutAttributionTool, registerSoldoutAttributionTool } from '../src/runtime/tools/soldout-attribution-tool.js'
import { registerSoldoutAttributionSkill } from '../src/runtime/skills/soldout-attribution-skill.js'
import { writePrivateConfig } from '../src/storage/config-store.js'

const CONFIG = {
  type: 'mysql', host: 'db.internal', port: 3306, database: 'sobuy-oms',
  username: 'readonly', password: 'secret', ssl: false,
  allowedTables: [], maxRows: 100, queryTimeoutMs: 5000,
}

const SKU_ROW = {
  sku: 'FRG225-W', warehouse_id: 50, warehouse_name: 'HS-A',
  soldout_rows: 82, order_count: 77, quantity_sum: '82',
  last_soldout_time: '2026-09-29 09:09:11',
  oldest_shortage_time: '2026-10-01 06:00:00', shortage_days: 4,
  overdue_ship_rows: 1, earliest_plan_print_time: '2026-10-05 09:00:00',
  soldout_state_rows: 60, processing_rows: 2, insufficient_rows: 0, presale_rows: 2, occupied_rows: 1,
  local_available: 0, other_warehouse_available: 102,
  warning_presell_num: 137, warning_critical_value: 20, warning_deal_flag: 0,
  has_warning: 1, warning_create_time: '2026-10-01 06:00:00',
  container_eta_store: '2026-10-10 08:00:00', container_ata_store: null,
  container_presale_expire: '2026-10-09 23:59:59', container_presale_status: 1, container_load_qty: 200,
  pending_shelving_tasks: 0, pending_task_owners: '', oldest_shelving_task_created_at: null,
  monthly_forecast_qty: 300, forecast_owners: '李四',
}

test('缺货归因参数只接受白名单字段，默认只看当前待处理的订单', () => {
  assert.deepEqual(normalizeAttributionParams({}), { window_days: 30, top_n: 20, group_by: 'sku', scope: 'active', warehouse_id: null })
  assert.deepEqual(normalizeAttributionParams({ window_days: 7, group_by: 'warehouse', warehouse_id: 50, top_n: 5 }), {
    window_days: 7, top_n: 5, group_by: 'warehouse', scope: 'active', warehouse_id: 50,
  })
  assert.equal(normalizeAttributionParams({ scope: 'historical' }).scope, 'historical')
  assert.throws(() => normalizeAttributionParams({ window_days: MAX_WINDOW_DAYS + 1 }), /window_days必须是 1 到 45/)
  assert.throws(() => normalizeAttributionParams({ window_days: 0 }), /window_days/)
  assert.throws(() => normalizeAttributionParams({ top_n: 501 }), /top_n必须是 1 到 500/)
  assert.throws(() => normalizeAttributionParams({ group_by: 'order_id' }), /只支持 sku 或 warehouse/)
  assert.throws(() => normalizeAttributionParams({ scope: 'all' }), /scope 只支持 active 或 historical/)
  assert.throws(() => normalizeAttributionParams({ sql: 'SELECT 1' }), /不支持参数：sql/)
  assert.throws(() => normalizeAttributionParams({ where: "1=1" }), /不支持参数：where/)
})

test('归因查询只生成单条只读 SELECT，且不选出任何客户隐私字段', () => {
  const built = buildSoldoutAttributionQuery({ window_days: 30, top_n: 20 })
  assert.match(built.sql, /^SELECT\b/)
  assert.equal(built.sql.includes(';'), false)
  assert.doesNotMatch(built.sql, /\b(UPDATE|DELETE|INSERT|DROP|ALTER|GRANT)\b/i)
  for (const table of SOLD_OUT_ATTRIBUTION_TABLES) assert.match(built.sql, new RegExp(`\\b${table}\\b`))
  assert.doesNotMatch(built.sql, /cust_|_tel|tel_|email|postcode|street|vat_|address|iban|iban_/i)
  assert.match(built.sql, /LIMIT \?$/)
  assert.deepEqual(built.values, [20])
  assert.deepEqual(built.meta, { groupBy: 'sku', scope: 'active', windowDays: 30, appliedLimit: 20, hasWarehouseFilter: false, timeRange: 'all_active' })
  assert.match(built.sql, /COALESCE\(is_send, 0\) <> 1/)
  assert.doesNotMatch(built.sql, /order_time >= DATE_SUB/)
  assert.match(built.sql, /other_inventory\.wsid <> grouped\.warehouse_id/)
  assert.match(built.sql, /ORDER BY COALESCE\(latest_warning\.update_time, latest_warning\.create_time\) DESC/)
  assert.match(built.sql, /oms_t_inventory_detail/)
  assert.match(built.sql, /bas_t_container_sku/)
  assert.match(built.sql, /report_t_predict_sku/)
  assert.match(built.sql, /overdue_ship_rows/)
  assert.match(built.sql, /monthly_forecast_qty/)

  const historical = buildSoldoutAttributionQuery({ scope: 'historical' })
  assert.match(historical.sql, /soldout_time IS NOT NULL/)
  assert.match(historical.sql, /order_time >= DATE_SUB\(NOW\(\), INTERVAL \? DAY\)/)
  assert.doesNotMatch(historical.sql, /COALESCE\(is_send, 0\) <> 1/)
  assert.deepEqual(historical.values, [30, 20])
})

test('仓库维度查询不联表推断原因，仓库过滤会追加占位符', () => {
  const warehouse = buildSoldoutAttributionQuery({ group_by: 'warehouse' })
  assert.match(warehouse.sql, /COUNT\(DISTINCT sku\) AS SIGNED\) AS sku_count/)
  assert.doesNotMatch(warehouse.sql, /oms_t_inventory|early_warn_inventory_info/)
  assert.deepEqual(warehouse.values, [20])

  const filtered = buildSoldoutAttributionQuery({ group_by: 'sku', warehouse_id: 50, window_days: 7, top_n: 3 })
  assert.match(filtered.sql, /AND warehouse_id = \?/)
  assert.equal(filtered.sql.match(/warehouse_id = \?/g).length, 1)
  assert.doesNotMatch(filtered.sql, /order_time >= DATE_SUB/)
  assert.deepEqual(filtered.values, [50, 3])
  assert.equal(filtered.meta.hasWarehouseFilter, true)
})

test('每种参数组合的占位符数量都与参数个数一致', () => {
  for (const input of [
    {}, { top_n: 5 }, { window_days: 7 },
    { group_by: 'warehouse' }, { group_by: 'warehouse', warehouse_id: 50 },
    { warehouse_id: 50 }, { group_by: 'sku', warehouse_id: 50, window_days: 45, top_n: 100 },
  ]) {
    const built = buildSoldoutAttributionQuery(input)
    assert.equal(
      built.sql.match(/\?/g).length, built.values.length,
      `占位符与参数个数不一致：${JSON.stringify(input)}`,
    )
  }
})

test('缺货原因返回主因、并发因素和下一步动作', () => {
  const base = { local_available: 0, local_usednum: 0, local_presale_occupied: 0, other_warehouse_available: 0, presale_rows: 0, warning_presell_num: 0, has_warning: 0 }
  assert.equal(classifyAttribution({ ...base, local_available: 12 }).attribution, 'local_stock_resolved')
  assert.equal(classifyAttribution({ ...base, other_warehouse_available: 102 }).attribution, 'warehouse_allocation_gap')
  assert.equal(classifyAttribution({ ...base, presale_rows: 2 }).attribution, 'presale_occupation')
  assert.equal(classifyAttribution({ ...base, warning_presell_num: 137 }).attribution, 'presale_occupation')
  assert.equal(classifyAttribution({ ...base, local_usednum: 8 }).attribution, 'local_stock_occupied')
  assert.equal(classifyAttribution({
    ...base, sample_container_num: 'CN-01', container_presale_status: 1, container_eta_store: '2026-10-12',
  }).attribution, 'container_in_transit')
  const shelving = classifyAttribution({ ...base, pending_shelving_tasks: 2, pending_task_owners: '张三' })
  assert.equal(shelving.attribution, 'shelving_pending')
  assert.match(shelving.attributionNote, /张三/)
  assert.equal(classifyAttribution({ ...base, has_warning: 1, warning_deal_flag: 0 }).attribution, 'warning_unhandled')
  const genuine = classifyAttribution({ ...base, has_warning: 1, warning_deal_flag: 1 })
  assert.equal(genuine.attribution, 'genuine_shortage')
  assert.match(genuine.primaryAction, /补货/)
  assert.match(classifyAttribution({ ...base, other_warehouse_available: 102 }).attributionNote, /102/)
  const composite = classifyAttribution({
    ...base, other_warehouse_available: 102, transfer_candidates: 'DE(20):102',
    presale_rows: 2, has_warning: 1, warning_deal_flag: 0,
  })
  assert.equal(composite.attribution, 'warehouse_allocation_gap')
  assert.deepEqual(composite.contributingFactors.map(item => item.code), ['presale_occupation', 'warning_unhandled'])
  assert.match(composite.primaryAction, /调拨/)
  assert.equal(composite.recommendedActions.length, 3)
})

test('行归一化把聚合结果转成结构化字段并挂上归因', () => {
  const rows = normalizeAttributionRows([SKU_ROW, { ...SKU_ROW, sku: 'X', local_available: '5' }])
  assert.equal(rows[0].sku, 'FRG225-W')
  assert.equal(rows[0].quantitySum, 82)
  assert.equal(rows[0].hasWarning, true)
  assert.equal(rows[0].attribution, 'warehouse_allocation_gap')
  assert.equal(rows[0].warningCreateTime, '2026-10-01 06:00:00')
  assert.equal(rows[0].shortageDays, 4)
  assert.equal(rows[0].overdueShipRows, 1)
  assert.equal(rows[0].containerLoadQty, 200)
  assert.equal(rows[0].monthlyForecastQty, 300)
  assert.equal(rows[0].forecastOwners, '李四')
  assert.equal(rows[1].attribution, 'local_stock_resolved')
  assert.equal(rows[1].localAvailable, 5)
  assert.equal(normalizeAttributionRows([{ ...SKU_ROW, soldout_rows: 2, shipped_rows: 2 }], 'sku', 'historical')[0].currentState, 'recovered_or_closed')

  const warehouseRows = normalizeAttributionRows([
    { warehouse_id: 50, warehouse_name: 'HS-A', sku_count: '84', soldout_rows: 284, order_count: 265, quantity_sum: '284', last_soldout_time: null },
  ], 'warehouse')
  assert.deepEqual(warehouseRows[0], {
    warehouseId: 50, warehouseName: 'HS-A', skuCount: 84, soldoutRows: 284, orderCount: 265,
    quantitySum: 284, lastSoldoutTime: '', soldoutStateRows: 0, processingRows: 0,
    insufficientRows: 0, presaleRows: 0, occupiedRows: 0, shippedRows: 0, closedRows: 0,
  })
})

test('缺货归因执行只读聚合查询，参数化传值并返回归因结果', async () => {
  const calls = []
  let ended = false
  const result = await runSoldoutAttribution(CONFIG, { window_days: 30, top_n: 20 }, {
    createConnection: async options => {
      assert.equal(options.multipleStatements, false)
      assert.equal(options.password, 'secret')
      return {
        execute: async (sql, values) => {
          calls.push({ sql, values })
          assert.match(sql, /^SELECT\b/)
          return [[SKU_ROW]]
        },
        end: async () => { ended = true },
      }
    },
    now: () => new Date(2026, 9, 6, 16, 40, 0),
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].values, [20])
  assert.deepEqual(Object.keys(result), ['windowDays', 'timeRange', 'groupBy', 'scope', 'generatedAt', 'groups', 'actionSummary', 'rows'])
  assert.equal(result.windowDays, 30)
  assert.equal(result.timeRange, 'all_active')
  assert.equal(result.scope, 'active')
  assert.equal(result.generatedAt, '2026-10-06 16:40:00')
  assert.equal(result.groups, 1)
  assert.equal(result.rows[0].attribution, 'warehouse_allocation_gap')
  assert.equal(result.rows[0].priority, 'P2')
  assert.equal(result.rows[0].impactLevel, 'critical')
  assert.equal(result.rows[0].shortageTrend, '反复')
  assert.equal(result.rows[0].recoveryStatus, 'container_in_transit')
  assert.equal(result.rows[0].recoveryEta, '2026-10-10 08:00:00')
  assert.equal(result.rows[0].forecastRisk, 'high')
  assert.equal(result.rows[0].responsibleOwners, '李四')
  assert.equal(result.actionSummary.byReason[0].quantitySum, 82)
  assert.equal(result.actionSummary.byImpact[0].impact, '紧急')
  assert.equal(result.actionSummary.byForecastRisk[0].forecastRisk, '高风险')
  assert.equal(result.actionSummary.byTrend[0].trend, '反复')
  assert.equal(ended, true)
  assert.deepEqual(CONFIG.allowedTables, [], '固定缺货归因不依赖业务表白名单')
})

test('缺货归因 Tool 从私有配置执行并渲染原因与依据', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-database-soldout-'))
  try {
    await writePrivateConfig(CONFIG, folder)
    const tool = createSoldoutAttributionTool({
      dataDirectory: folder,
      attribution: async (config, args) => {
        assert.equal(config.database, 'sobuy-oms')
        assert.deepEqual(args, { window_days: 30 })
        const actionSummary = buildAttributionActionSummary(
          normalizeAttributionRows([SKU_ROW]), 'sku', new Date(2026, 9, 6, 16, 40, 0),
        )
        return {
          windowDays: 30, timeRange: 'all_active', groupBy: 'sku', scope: 'active', generatedAt: '2026-10-06 16:40:00', groups: 1,
          actionSummary: {
            scope: actionSummary.scope,
            byReason: actionSummary.byReason,
            byWarehouse: actionSummary.byWarehouse,
            byOwner: actionSummary.byOwner,
            byImpact: actionSummary.byImpact,
            byForecastRisk: actionSummary.byForecastRisk,
            byTrend: actionSummary.byTrend,
          },
          rows: actionSummary.queue,
        }
      },
    })
    const value = await tool.execute({ window_days: 30 }, { signal: new AbortController().signal })
    assert.equal(tool.name, 'database_soldout_attribution')
    assert.deepEqual(tool.output.schema.required, ['windowDays', 'timeRange', 'groupBy', 'scope', 'generatedAt', 'groups', 'actionSummary', 'rows'])
    assert.equal(tool.parameters.additionalProperties, false)
    assert.deepEqual(tool.parameters.properties.group_by.enum, ['sku', 'warehouse'])
    assert.deepEqual(Object.keys(tool.output.schema.properties.rows.items.properties).filter(key => key.startsWith('container')).sort(), [
      'containerAtaStore', 'containerCount', 'containerEtaStore', 'containerLoadQty', 'containerPresaleExpire', 'containerPresaleStatus',
    ])
    assert.deepEqual(dshToolValueViolations(tool.output.schema, value), [])

    const text = tool.output.render({}, value)[0].text
    assert.match(text, /全部当前待处理订单归因（按SKU 与仓库聚合/)
    assert.match(text, /FRG225-W @ HS-A\(50\)( \[P2\])?：缺货 82 行 \/ 77 单 \/ 82 件/)
    assert.match(text, /原因：发货仓可用 0；其他仓合计可用 102/)
    assert.match(text, /依据：发货仓可用 0；其他仓可用 102；预警预售量 137；预警未处理/)
    assert.match(text, /影响：紧急；已有 1 行超过强制发货时间/)
    assert.match(text, /趋势：反复缺货，窗口内涉及 4 个下单日；1 行已超过强制发货时间/)
    assert.match(text, /恢复依据：关联货柜尚未实际到库，该 SKU 装柜量 200。 预计时间 2026-10-10 08:00:00/)
    assert.match(text, /预测风险：高风险；按本月预测日均 10 件计算，当前可用库存仅覆盖约 0 天/)
    assert.match(text, /责任人：李四/)
    assert.match(text, /建议：优先核实候选仓可调拨性/)
    assert.match(text, /并发因素：预售占用可发库存；关联预售货柜尚未到库；库存预警尚未处理/)
    assert.match(text, /不是数据库中的原因字段/)
    assert.doesNotMatch(text, /secret|db\.internal|password/)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('缺货归因 Tool 不把驱动错误原文带出，空结果给出明确提示', async () => {
  const tool = createSoldoutAttributionTool({
    dataDirectory: '/tmp/does-not-matter',
    attribution: async () => {
      const error = new Error('Access denied for readonly using password secret at db.internal')
      error.code = 'ER_ACCESS_DENIED_ERROR'
      throw error
    },
  })
  await assert.rejects(
    tool.execute({}, { signal: new AbortController().signal }),
    error => !/secret|db\.internal|Access denied/i.test(error.message),
  )

  const empty = tool.output.render({}, { windowDays: 7, timeRange: 'all_active', groupBy: 'warehouse', scope: 'active', generatedAt: '', groups: 0, rows: [] })[0].text
  assert.match(empty, /没有发现当前仍待处理的缺货订单记录/)

  const warehouseText = tool.output.render({}, {
    windowDays: 30, timeRange: 'all_active', groupBy: 'warehouse', scope: 'active', generatedAt: '', groups: 1,
    rows: [{ warehouseId: 50, warehouseName: 'HS-A', skuCount: 84, soldoutRows: 284, orderCount: 265, quantitySum: 284, lastSoldoutTime: '' }],
  })[0].text
  assert.match(warehouseText, /HS-A\(50\)：缺货 284 行 \/ 265 单 \/ 284 件；涉及 SKU 84 个/)
  assert.match(warehouseText, /仓库维度不推断原因/)
})

test('缺货归因 Tool 与 Skill 通过 DSH 运行时注册', () => {
  const tools = []
  const skills = []
  const ctx = {
    tools: { register: definition => { tools.push(definition); return () => {} } },
    skills: { register: definition => { skills.push(definition); return () => {} } },
  }
  registerSoldoutAttributionTool(ctx, { dataDirectory: '/tmp/database-soldout-register-test' })
  registerSoldoutAttributionSkill(ctx)
  assert.deepEqual(tools.map(tool => tool.name), ['database_soldout_attribution'])
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'database-soldout-attribution')
  assert.equal(skills[0].source, 'bundled')
  assert.deepEqual(skills[0].invocation, { modelInvocable: true, userInvocable: true })
  assert.match(skills[0].content, /database_soldout_attribution/)
  assert.match(skills[0].content, /不是数据库里读出来的字段/)
  assert.match(skills[0].content, /时间锚点是订单下单时间/)
  assert.equal(skills[0].content.startsWith('---'), false)
})
