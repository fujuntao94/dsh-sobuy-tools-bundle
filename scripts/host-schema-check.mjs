#!/usr/bin/env node
/**
 * 用宿主（DeepSeek Harness）**自己的** JSON Schema 校验器检查本仓所有工具定义。
 *
 * 为什么需要它：宿主的 `tools.register()` 会对 `output.schema` 调
 * `assertSupportedJsonSchema()`；不合规就抛 JsonSchemaError，而该异常发生在插件
 * entry 激活阶段 —— 一个字段写错，整个组件（含其它正常工具）都会「启用失败」。
 * 单测（test/tool-schema.test.js）用的是本仓复刻的规则，本脚本用的是宿主原文，
 * 因此两者互补：单测防回归，本脚本在调试激活失败时给出与宿主一致的判定。
 *
 * 用法：
 *   node scripts/host-schema-check.mjs           # 只校验 schema（离线，秒级）
 *   node scripts/host-schema-check.mjs --live    # 额外用真实只读库校验输出值
 *   DSH_APP_PATH=/path/to/App.app node scripts/host-schema-check.mjs
 *
 * 原理：从 app.asar 中抽出 `lib/types/json-schema.js` 的 region 原文，补上少数
 * 外部依赖（HarnessError / walkJsonValue 等，全部按原文抽取）后动态加载。
 * 抽出来的是**当前安装版本**的代码，因此宿主升级后本脚本自动跟随。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_PATH = process.env.DSH_APP_PATH ?? '/Applications/DeepSeek Harness.app'
const ASAR = path.join(APP_PATH, 'Contents/Resources/app.asar')
const live = process.argv.includes('--live')

if (!fs.existsSync(ASAR)) {
  console.error(`未找到宿主包：${ASAR}`)
  console.error('请用 DSH_APP_PATH 指定 DeepSeek Harness.app 的位置。')
  process.exit(2)
}

// ---- 第一步：抽出宿主原文校验器 ----
const source = fs.readFileSync(ASAR).toString('utf8')

function grabFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`未找到函数 ${name}`)
  const open = source.indexOf('{', start)
  let depth = 0
  let index = open
  for (; index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}') {
      depth--
      if (depth === 0) { index++; break }
    }
  }
  return source.slice(start, index)
}

const regionStart = source.indexOf('//#region lib/types/json-schema.js')
const regionEnd = source.indexOf('//#endregion', regionStart)
if (regionStart < 0 || regionEnd < 0) throw new Error('宿主的 json-schema region 抽取失败，宿主结构可能已变更')
const region = source.slice(regionStart, regionEnd)

// region 之外、但被它引用的纯函数，按原文补齐（已定义的跳过）
const EXTERNALS = [
  'hasIntrinsicConstructor', 'isIntrinsicObjectPrototype', 'hasPlainArrayPrototype',
  'hasPlainObjectPrototype', 'enumerableStringKeys', 'assertNever', 'walkJsonValue',
]
const prelude = [
  'class HarnessError extends Error {',
  '  constructor(message, code) { super(message); this.name = "HarnessError"; if (code !== undefined) this.code = code }',
  '}',
  ...EXTERNALS.filter(name => !region.includes(`function ${name}(`)).map(grabFunction),
  'function isJsonValue(value) { return walkJsonValue(value, false) === true }',
].join('\n')

const modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-schema-'))
const validatorPath = path.join(modulesDir, 'host-json-schema.mjs')
fs.writeFileSync(validatorPath, `${prelude}\n${region}\nexport { assertSupportedJsonSchema, validateJsonSchemaValue }\n`)

const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(validatorPath)

// ---- 第二步：按真实注册路径收集工具定义 ----
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const captured = []
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  tools: { register: definition => { captured.push(definition) } },
  effect: () => () => {},
  get: () => undefined,
  provide: () => {},
  on: () => {},
}
const targets = [
  ['components/database/src/runtime/tools/list-tables-tool.js', 'registerListTablesTool', {}],
  ['components/database/src/runtime/tools/describe-table-tool.js', 'registerDescribeTableTool', {}],
  ['components/database/src/runtime/tools/soldout-attribution-tool.js', 'registerSoldoutAttributionTool', {}],
  ['components/database/src/runtime/tools/inventory-shortage-forecast-tool.js', 'registerInventoryShortageForecastTool', {}],
  ['components/database/src/runtime/tools/dictionary-tool.js', 'registerDictionaryTool', {}],
  ['components/database/src/runtime/tools/order-timeline-tool.js', 'registerOrderTimelineTool', {}],
  ['components/database/src/runtime/tools/security-check-tool.js', 'registerSecurityCheckTool', { securityService: {} }],
  ['components/feishu/src/runtime/tools/user-info-tool.js', 'registerUserInfoTool', {}],
  ['components/feishu/src/runtime/tools/department-tool.js', 'registerDepartmentTool', {}],
  ['components/feishu/src/runtime/tools/leave-balance-tool.js', 'registerLeaveBalanceTool', {}],
  ['components/feishu/src/runtime/tools/capabilities-tool.js', 'registerCapabilitiesTool', {}],
  ['components/feishu/src/runtime/tools/operation-log-tool.js', 'registerOperationLogTool', {}],
  ['components/feishu/src/runtime/tools/login-tool.js', 'registerLoginTool', {}],
]
for (const [file, fn, options] of targets) {
  const mod = await import(path.join(repoRoot, file))
  if (typeof mod[fn] !== 'function') throw new Error(`${file} 未导出 ${fn}`)
  mod[fn](fakeCtx, options)
}

console.log(`宿主：${APP_PATH}`)
console.log(`\n=== schema 校验（复现 tools.register() 的断言）===`)
let schemaFailures = 0
for (const definition of captured) {
  try {
    assertSupportedJsonSchema(definition.output.schema)
    console.log(`  ✓ ${definition.name}`)
  } catch (error) {
    schemaFailures++
    console.log(`  ✗ ${definition.name}\n      ${error.message}`)
  }
}
console.log(`  → ${captured.length} 个工具，${schemaFailures} 个不合规`)

let valueFailures = 0
if (live) {
  console.log('\n=== 输出值校验（真实只读库；复现运行时的 createSuccessResult）===')
  const configPath = path.join(os.homedir(), '.dsh/database-tools/config.json')
  if (!fs.existsSync(configPath)) {
    console.log(`  跳过：未找到 ${configPath}（请先在数据库设置页保存连接）`)
  } else {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const { runDictionaryLookup } = await import(path.join(repoRoot, 'components/database/src/domains/dictionary.js'))
    const { runSoldoutAttribution } = await import(path.join(repoRoot, 'components/database/src/domains/soldout-attribution.js'))
    const { runInventoryShortageForecast } = await import(path.join(repoRoot, 'components/database/src/domains/inventory-shortage-forecast.js'))
    const byName = new Map(captured.map(definition => [definition.name, definition]))
    const checks = [
      ['database_dictionary_lookup', '字典目录（全部筛选为空）', () => runDictionaryLookup(config, {})],
      ['database_dictionary_lookup', '按 dict_id=3', () => runDictionaryLookup(config, { dict_id: 3 })],
      ['database_dictionary_lookup', '按 dict_value=G17', () => runDictionaryLookup(config, { dict_value: 'G17' })],
      ['database_dictionary_lookup', '按 keyword 模糊匹配', () => runDictionaryLookup(config, { keyword: '投递' })],
      ['database_soldout_attribution', '缺货归因（按 SKU）', () => runSoldoutAttribution(config, { window_days: 30, top_n: 5 })],
      ['database_soldout_attribution', '缺货归因（按仓库）', () => runSoldoutAttribution(config, { window_days: 30, group_by: 'warehouse', top_n: 5 })],
      ['database_inventory_shortage_forecast', '预测性缺货预警', () => runInventoryShortageForecast(config, { coverage_days: 14, top_n: 5 })],
    ]
    for (const [name, label, run] of checks) {
      const value = await run()
      const violations = validateJsonSchemaValue(byName.get(name).output.schema, value, 'value')
      if (violations.length === 0) console.log(`  ✓ ${label}`)
      else { valueFailures++; console.log(`  ✗ ${label}\n      ${violations.join('; ')}`) }
    }
  }
}

fs.rmSync(modulesDir, { recursive: true, force: true })
console.log(`\n结论：schema 不合规 ${schemaFailures} 个；输出值不合规 ${valueFailures} 个`)
process.exit(schemaFailures + valueFailures === 0 ? 0 : 1)
