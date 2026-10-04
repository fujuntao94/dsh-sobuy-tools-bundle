import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listDatabaseTables, normalizeTableCatalog } from '../src/domains/table-catalog.js'
import { createListTablesTool, registerListTablesTool } from '../src/runtime/tools/list-tables-tool.js'
import { registerTableCatalogSkill } from '../src/runtime/skills/table-catalog-skill.js'
import { writePrivateConfig } from '../src/storage/config-store.js'

const CONFIG = {
  type: 'mysql',
  host: 'db.internal',
  port: 3306,
  database: 'orders',
  username: 'readonly',
  password: 'secret',
  ssl: true,
}

test('表目录只查询当前数据库的基础表，并使用表备注作为用途', async () => {
  const calls = []
  let ended = false
  const result = await listDatabaseTables(CONFIG, {
    createConnection: async options => {
      assert.equal(options.multipleStatements, false)
      assert.deepEqual(options.ssl, {})
      return {
        execute: async (sql, values) => {
          calls.push({ sql, values })
          return [[
            { tableName: 'orders', tableComment: '订单主表' },
            { tableName: 'users', tableComment: '' },
          ]]
        },
        end: async () => { ended = true },
      }
    },
  })
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /information_schema\.tables/)
  assert.match(calls[0].sql, /TABLE_TYPE = 'BASE TABLE'/)
  assert.deepEqual(calls[0].values, ['orders'])
  assert.deepEqual(result, {
    total: 2,
    tables: [
      { name: 'orders', purpose: '订单主表' },
      { name: 'users', purpose: '未填写表备注' },
    ],
  })
  assert.equal(ended, true)
})

test('表目录规范化会忽略无效表名，且不根据表名猜用途', () => {
  assert.deepEqual(normalizeTableCatalog([
    { tableName: '', tableComment: '无效' },
    { tableName: 'audit_log', tableComment: '   ' },
  ]), {
    total: 1,
    tables: [{ name: 'audit_log', purpose: '未填写表备注' }],
  })
})

test('数据表 Tool 从私有配置执行，并只返回数量、表名和用途', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-database-table-tool-'))
  try {
    await writePrivateConfig(CONFIG, folder)
    const tool = createListTablesTool({
      dataDirectory: folder,
      listTables: async (config, { signal }) => {
        assert.equal(config.database, 'orders')
        assert.equal(signal.aborted, false)
        return { total: 1, tables: [{ name: 'orders', purpose: '订单主表' }] }
      },
    })
    const controller = new AbortController()
    const value = await tool.execute({}, { signal: controller.signal })
    assert.deepEqual(value, { total: 1, tables: [{ name: 'orders', purpose: '订单主表' }] })
    assert.equal(tool.name, 'database_list_tables')
    assert.deepEqual(tool.parameters.properties, {})
    assert.deepEqual(tool.output.schema.required, ['total', 'tables'])
    assert.deepEqual(tool.output.schema.properties.tables.items.required, ['name', 'purpose'])
    assert.match(tool.output.render({}, value)[0].text, /orders：订单主表/)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('数据表 Tool 和 Skill 通过 DSH 运行时注册', () => {
  const tools = []
  const skills = []
  const ctx = {
    tools: { register: definition => { tools.push(definition); return () => {} } },
    skills: { register: definition => { skills.push(definition); return () => {} } },
  }
  registerListTablesTool(ctx, { dataDirectory: '/tmp/database-table-catalog-test' })
  registerTableCatalogSkill(ctx)
  assert.deepEqual(tools.map(tool => tool.name), ['database_list_tables'])
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'database-table-catalog')
  assert.equal(skills[0].source, 'bundled')
  assert.deepEqual(skills[0].invocation, { modelInvocable: true, userInvocable: true })
  assert.match(skills[0].content, /database_list_tables/)
  assert.match(skills[0].content, /不要根据表名猜测/)
  assert.doesNotMatch(skills[0].content, /^---/)
})
