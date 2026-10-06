import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { describeDatabaseTable, normalizeTableName, normalizeTableSchema } from '../src/domains/table-schema.js'
import { createDescribeTableTool, registerDescribeTableTool } from '../src/runtime/tools/describe-table-tool.js'
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

test('表结构查询只访问当前数据库的 information_schema.columns', async () => {
  const calls = []
  let ended = false
  const result = await describeDatabaseTable(CONFIG, 'orders', {
    createConnection: async () => ({
      execute: async (sql, values) => {
        calls.push({ sql, values })
        return [[
          { columnName: 'id', columnType: 'bigint unsigned', nullable: 'NO', columnKey: 'PRI', columnComment: '主键' },
          { columnName: 'order_no', columnType: 'varchar(64)', nullable: 'NO', columnKey: 'UNI', columnComment: '订单号' },
          { columnName: 'phone', columnType: 'varchar(32)', nullable: 'YES', columnKey: '', columnComment: '' },
        ]]
      },
      end: async () => { ended = true },
    }),
  })
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /information_schema\.columns/)
  assert.match(calls[0].sql, /TABLE_SCHEMA = \? AND TABLE_NAME = \?/)
  assert.doesNotMatch(calls[0].sql, /COLUMN_DEFAULT/)
  assert.deepEqual(calls[0].values, ['orders', 'orders'])
  assert.deepEqual(result, {
    table: 'orders',
    total: 3,
    columns: [
      { name: 'id', type: 'bigint unsigned', nullable: false, key: 'PRI', comment: '主键' },
      { name: 'order_no', type: 'varchar(64)', nullable: false, key: 'UNI', comment: '订单号' },
      { name: 'phone', type: 'varchar(32)', nullable: true, key: '', comment: '未填写字段备注' },
    ],
  })
  assert.equal(ended, true)
})

test('表结构规范化拒绝无效表名，并忽略缺少名称或类型的元数据', () => {
  assert.throws(() => normalizeTableName(''), /表名称无效/)
  assert.throws(() => normalizeTableName(`orders\n`), /表名称无效/)
  assert.deepEqual(normalizeTableSchema('orders', [
    { columnName: '', columnType: 'varchar(20)' },
    { columnName: 'id', columnType: '' },
  ]), { table: 'orders', total: 0, columns: [] })
})

test('表结构 Tool 从私有配置读取，返回字段元数据且不记录业务结果', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-database-schema-tool-'))
  const auditEvents = []
  try {
    await writePrivateConfig(CONFIG, folder)
    const tool = createDescribeTableTool({
      dataDirectory: folder,
      describeTable: async (config, table, { signal }) => {
        assert.equal(config.database, 'orders')
        assert.equal(table, 'orders')
        assert.equal(signal.aborted, false)
        return {
          table,
          total: 1,
          columns: [{ name: 'id', type: 'bigint', nullable: false, key: 'PRI', comment: '主键' }],
        }
      },
      auditLogger: { record: event => auditEvents.push(event) },
    })
    const controller = new AbortController()
    const value = await tool.execute({ table: 'orders' }, { signal: controller.signal })
    assert.equal(tool.name, 'database_describe_table')
    assert.deepEqual(tool.parameters.required, ['table'])
    assert.deepEqual(value.columns[0], { name: 'id', type: 'bigint', nullable: false, key: 'PRI', comment: '主键' })
    assert.match(tool.output.render({}, value)[0].text, /数据表 orders 共有 1 个字段/)
    assert.deepEqual(auditEvents, [{ operation: 'describe_table', status: 'success', table: 'orders', columnCount: 1, durationMs: auditEvents[0].durationMs }])
    assert.equal(typeof auditEvents[0].durationMs, 'number')
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('表结构 Tool 通过 DSH 运行时注册', () => {
  const tools = []
  const ctx = { tools: { register: definition => { tools.push(definition); return () => {} } } }
  registerDescribeTableTool(ctx, { dataDirectory: '/tmp/database-table-schema-test' })
  assert.deepEqual(tools.map(tool => tool.name), ['database_describe_table'])
})
