/**
 * 工具 schema 与宿主（DSH）子集的一致性回归测试。
 *
 * 背景：`tools.register()` 会对 `output.schema` 调 `assertSupportedJsonSchema()`，
 * 不合规就抛 JsonSchemaError，而该异常发生在插件 entry 激活阶段 —— 一个字段写错，
 * 整个组件（含其它正常工具）全部无法激活。
 *
 * 真实事故：`type: ['number', 'null']` 让数据库组件 6 个工具一起「启用失败」。
 * 这个测试把「所有已注册工具的 output.schema 都必须合规」固化为不变量，
 * 并把事件当时的确切报错文本作为防回归样例。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertDshToolSchema,
  assertDshToolValue,
  dshToolSchemaViolations,
  dshToolValueViolations,
  nullableSchema,
} from 'sobuy-plugin-core/schema'

/** 用假 ctx 走一遍真实注册路径，收集工具定义。 */
async function collectToolDefinitions() {
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
    ['../components/database/src/runtime/tools/list-tables-tool.js', 'registerListTablesTool', {}],
    ['../components/database/src/runtime/tools/describe-table-tool.js', 'registerDescribeTableTool', {}],
    ['../components/database/src/runtime/tools/soldout-attribution-tool.js', 'registerSoldoutAttributionTool', {}],
    ['../components/database/src/runtime/tools/dictionary-tool.js', 'registerDictionaryTool', {}],
    ['../components/database/src/runtime/tools/order-timeline-tool.js', 'registerOrderTimelineTool', {}],
    ['../components/database/src/runtime/tools/security-check-tool.js', 'registerSecurityCheckTool', { securityService: {} }],
    ['../components/feishu/src/runtime/tools/user-info-tool.js', 'registerUserInfoTool', {}],
    ['../components/feishu/src/runtime/tools/department-tool.js', 'registerDepartmentTool', {}],
    ['../components/feishu/src/runtime/tools/leave-balance-tool.js', 'registerLeaveBalanceTool', {}],
    ['../components/feishu/src/runtime/tools/capabilities-tool.js', 'registerCapabilitiesTool', {}],
    ['../components/feishu/src/runtime/tools/operation-log-tool.js', 'registerOperationLogTool', {}],
    ['../components/feishu/src/runtime/tools/login-tool.js', 'registerLoginTool', {}],
  ]
  for (const [file, fn, options] of targets) {
    const mod = await import(file)
    assert.equal(typeof mod[fn], 'function', `${fn} 应该被导出`)
    mod[fn](fakeCtx, options)
  }
  return captured
}

const definitions = await collectToolDefinitions()
const merged = new Map(definitions.map(definition => [definition.name, definition]))

test('两个组件的工具都被注册到，且没有重名', () => {
  assert.equal(definitions.length, 12)
  assert.equal(merged.size, definitions.length)
})

test('每个工具的 output.schema 都符合宿主支持子集', () => {
  for (const definition of definitions) {
    const violations = dshToolSchemaViolations(definition.output.schema)
    assert.deepEqual(violations, [], `${definition.name} 的 output.schema 不合规：${violations.join('; ')}`)
    assert.doesNotThrow(() => assertDshToolSchema(definition.output.schema), definition.name)
  }
})

test('所有 output.schema 都不使用联合类型数组（本次事故的直接成因）', () => {
  const walk = (node, path, found) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach((entry, index) => walk(entry, `${path}[${index}]`, found)); return }
    if (Array.isArray(node.type)) found.push(`${path}.type = ${JSON.stringify(node.type)}`)
    if (node.properties) for (const [key, child] of Object.entries(node.properties)) walk(child, `${path}.properties.${key}`, found)
    if (node.items) walk(node.items, `${path}.items`, found)
    if (node.oneOf) node.oneOf.forEach((branch, index) => walk(branch, `${path}.oneOf[${index}]`, found))
  }
  for (const definition of definitions) {
    const found = []
    walk(definition.output.schema, 'schema', found)
    assert.deepEqual(found, [], `${definition.name} 仍在使用联合类型：${found.join('; ')}`)
  }
})

test('宿主会以 type array 报文拒绝旧写法', () => {
  const legacy = {
    type: 'object',
    properties: {
      filters: {
        type: 'object',
        properties: {
          dictId: { type: ['number', 'null'] },
          dictValue: { type: ['string', 'null'] },
          keyword: { type: ['string', 'null'] },
        },
      },
    },
  }
  const violations = dshToolSchemaViolations(legacy)
  assert.equal(violations.length, 3)
  assert.ok(violations.every(item => item.includes('must be a single type string (type arrays are not supported)')))
  assert.throws(() => assertDshToolSchema(legacy), /unsupported JSON schema/)
})

test('nullableSchema 是受支持的写法，且取值校验是双向的', () => {
  const schema = { type: 'object', properties: { dictId: nullableSchema('number', '可空') }, additionalProperties: false }
  assert.deepEqual(dshToolSchemaViolations(schema), [])
  assert.deepEqual(dshToolValueViolations(schema, { dictId: 3 }), [])
  assert.deepEqual(dshToolValueViolations(schema, { dictId: null }), [])
  assert.equal(dshToolValueViolations(schema, { dictId: '3' }).length, 1)
  assert.equal(dshToolValueViolations(schema, {}).length, 0, '非必填字段缺省应通过')
})

test('字典工具在「三个筛选条件全为空」时输出仍能通过运行时校验', () => {
  const definition = merged.get('database_dictionary_lookup')
  const value = {
    mode: 'catalog',
    filters: { dictId: null, dictValue: null, keyword: null, includeDeprecated: false },
    dictionaries: [{ dictId: 3, dictName: 'Types Of Complaint', deprecated: false }],
    entries: [],
    returned: 0,
    truncated: false,
    generatedAt: '2026-10-06 18:00:00',
  }
  assert.deepEqual(dshToolValueViolations(definition.output.schema, value), [])
  assert.doesNotThrow(() => assertDshToolValue(definition.output.schema, value))
})

test('字典工具在带 dict_id 时输出也能通过运行时校验', () => {
  const definition = merged.get('database_dictionary_lookup')
  const value = {
    mode: 'entries',
    filters: { dictId: 3, dictValue: null, keyword: null, includeDeprecated: false },
    dictionaries: [],
    entries: [{ dictId: 3, dictName: 'Types Of Complaint', dictValue: 'G17', note: '缺货', enabled: true, deprecated: false }],
    returned: 1,
    truncated: false,
    generatedAt: '2026-10-06 18:00:00',
  }
  assert.deepEqual(dshToolValueViolations(definition.output.schema, value), [])
})

test('输出值校验能识别多余字段与缺失必填字段', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['a'],
    properties: { a: { type: 'string' } },
  }
  assert.deepEqual(dshToolValueViolations(schema, { a: 'x' }), [])
  assert.deepEqual(dshToolValueViolations(schema, {}), ['missing required property "a"'])
  assert.deepEqual(dshToolValueViolations(schema, { a: 'x', b: 1 }), ['"b" is not a declared property (additionalProperties: false)'])
})

test('把真实工具的可空字段改回联合类型会被本测试抓住（变异验证）', () => {
  const definition = merged.get('database_dictionary_lookup')
  const mutated = structuredClone(definition.output.schema)
  mutated.properties.filters.properties.dictId = { type: ['number', 'null'] }
  const violations = dshToolSchemaViolations(mutated)
  assert.equal(violations.length, 1)
  assert.match(violations[0], /schema\.properties\.filters\.properties\.dictId\.type must be a single type string/)
})
