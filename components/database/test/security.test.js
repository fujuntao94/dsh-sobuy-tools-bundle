import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeAccountGrants } from '../src/domains/account-security.js'
import { runDatabaseOperation } from '../src/domains/connection.js'
import { normalizeSecurityPolicy, resolveSecurityPolicy } from '../src/security/policy.js'
import { createQueryAuditLogger, redactQueryAuditEvent } from '../src/security/query-audit.js'
import { buildSafeSelect, executeSafeSelect } from '../src/security/safe-select.js'
import { createSecurityCheckTool } from '../src/runtime/tools/security-check-tool.js'
import { registerSecurityCheckSkill } from '../src/runtime/skills/security-check-skill.js'

const CONFIG = {
  host: 'db.internal', port: 3306, database: 'orders', username: 'readonly', password: 'secret', ssl: false,
  allowedTables: ['orders'], maxRows: 50, queryTimeoutMs: 1000,
  sensitiveFields: ['password', 'token', 'mobile'],
}

test('安全策略限制白名单、最大行数、超时和敏感字段规则', () => {
  assert.deepEqual(normalizeSecurityPolicy({
    allowedTables: 'orders\norder_items,orders', maxRows: '20', queryTimeoutMs: '2500', sensitiveFields: 'password\ntoken',
  }), {
    allowedTables: ['orders', 'order_items'], maxRows: 20, queryTimeoutMs: 2500, sensitiveFields: ['password', 'token'],
  })
  assert.throws(() => normalizeSecurityPolicy({ maxRows: '5001', queryTimeoutMs: '5000' }), /最大返回行数/)
  assert.throws(() => normalizeSecurityPolicy({ maxRows: '10', queryTimeoutMs: '100' }), /查询超时/)
  assert.throws(() => normalizeSecurityPolicy({ allowedTables: `orders\n${'x'.repeat(65)}` }), /白名单包含无效名称/)
  assert.equal(resolveSecurityPolicy({ maxRows: 99999 }).maxRows, 500)
})

test('结构化查询只生成单条 SELECT，并强制白名单、参数化和最大行数', () => {
  const built = buildSafeSelect({
    table: 'orders', columns: ['id', 'status'], conditions: { status: 'paid' }, limit: 500,
  }, CONFIG)
  assert.equal(built.sql, 'SELECT `id`, `status` FROM `orders` WHERE `status` = ? LIMIT ?')
  assert.deepEqual(built.values, ['paid', 50])
  assert.equal(built.meta.appliedLimit, 50)
  assert.throws(() => buildSafeSelect({ table: 'users' }, CONFIG), /不在白名单/)
  assert.throws(() => buildSafeSelect({ table: 'orders', sql: 'DELETE FROM orders' }, CONFIG), /不支持参数：sql/)
  assert.doesNotMatch(built.sql, /;|UPDATE|DELETE|INSERT/i)
})

test('安全查询会屏蔽敏感字段，连接固定禁用多语句，并写入脱敏审计日志', async () => {
  const logs = []
  let ended = false
  const auditLogger = createQueryAuditLogger({ info: entry => logs.push(entry), warn: entry => logs.push(entry) })
  const result = await executeSafeSelect(CONFIG, { table: 'orders', columns: ['id', 'password', 'profile'], limit: 5 }, {
    auditLogger,
    createConnection: async options => {
      assert.equal(options.multipleStatements, false)
      assert.equal(options.password, 'secret')
      return {
        execute: async (sql, values) => {
          assert.match(sql, /^SELECT /)
          assert.deepEqual(values, [5])
          return [[{ id: 1, password: 'raw-secret', profile: { mobile: '13800000000', nickname: '测试' } }]]
        },
        destroy: () => {},
        end: async () => { ended = true },
      }
    },
    now: (() => { let value = 100; return () => value += 5 })(),
  })
  assert.deepEqual(result.rows, [{ id: 1, password: '[REDACTED]', profile: { mobile: '[REDACTED]', nickname: '测试' } }])
  assert.equal(ended, true)
  assert.equal(logs.length, 1)
  assert.deepEqual(Object.keys(logs[0]).sort(), ['appliedLimit', 'columnCount', 'component', 'conditionCount', 'durationMs', 'operation', 'rowCount', 'status', 'table'].sort())
  assert.doesNotMatch(JSON.stringify(logs), /raw-secret|13800000000|SELECT|db\.internal/)
})

test('数据库操作超时会销毁连接并返回稳定错误类型', async () => {
  let destroyed = false
  await assert.rejects(
    runDatabaseOperation(CONFIG, () => new Promise(() => {}), {
      timeoutMs: 5,
      createConnection: async () => ({ destroy: () => { destroyed = true }, end: async () => {} }),
    }),
    error => error.code === 'DATABASE_QUERY_TIMEOUT',
  )
  assert.equal(destroyed, true)
})

test('驱动错误不会把连接错误原文或凭据带出安全查询服务', async () => {
  const logs = []
  await assert.rejects(
    executeSafeSelect(CONFIG, { table: 'orders' }, {
      auditLogger: createQueryAuditLogger({ warn: entry => logs.push(entry) }),
      createConnection: async () => ({
        execute: async () => {
          const error = new Error('Access denied for readonly using password secret at db.internal')
          error.code = 'ER_ACCESS_DENIED_ERROR'
          throw error
        },
        destroy: () => {},
        end: async () => {},
      }),
    }),
    error => error.code === 'DATABASE_AUTHENTICATION_FAILED'
      && !/secret|db\.internal|Access denied/i.test(error.message),
  )
  assert.equal(logs[0].errorKind, 'authentication')
  assert.doesNotMatch(JSON.stringify(logs), /secret|db\.internal|Access denied/i)
})

test('查询审计日志采用字段白名单，丢弃 SQL、参数、结果和错误原文', () => {
  const safe = redactQueryAuditEvent({
    operation: 'select', status: 'error', table: 'orders', sql: 'SELECT secret', params: ['password'], rows: [{ token: 'x' }], error: 'db.internal', errorKind: 'query_failed',
  })
  assert.deepEqual(safe, {
    component: 'sobuy-database-tools', operation: 'select', status: 'error', table: 'orders', errorKind: 'query_failed',
  })
})

test('账号权限区分已确认只读、明确可写和需要人工确认', () => {
  assert.equal(analyzeAccountGrants([{ Grants: 'GRANT SELECT, SHOW VIEW ON `orders`.* TO `reader`@`%`' }]).status, 'read_only')
  const writable = analyzeAccountGrants([{ Grants: 'GRANT SELECT, INSERT, UPDATE ON `orders`.* TO `writer`@`%`' }])
  assert.equal(writable.status, 'writable')
  assert.deepEqual(writable.writePrivileges, ['INSERT', 'UPDATE'])
  assert.equal(analyzeAccountGrants([{ Grants: "GRANT 'app_reader'@'%' TO 'user'@'%'" }]).status, 'unknown')
})

test('安全检查 Tool 与 Skill 只暴露脱敏安全状态', async () => {
  const securityService = {
    checkReadonly: async () => ({ status: 'read_only', readOnlyVerified: true, writePrivileges: [], reviewPrivileges: [], reason: '当前授权清单仅包含只读权限。' }),
    policy: async () => ({
      allowedTables: ['orders'], maxRows: 50, queryTimeoutMs: 1000, sensitiveFields: ['password'],
      arbitrarySqlAllowed: false, multipleStatementsAllowed: false, writeStatementsAllowed: false, queryLogsRedacted: true,
    }),
  }
  const tool = createSecurityCheckTool({ securityService })
  const result = await tool.execute({}, {})
  assert.equal(result.account.status, 'read_only')
  assert.equal(result.policy.writeStatementsAllowed, false)
  assert.doesNotMatch(tool.output.render({}, result)[0].text, /secret|password/i)

  const registrations = []
  registerSecurityCheckSkill({ skills: { register: skill => { registrations.push(skill); return () => {} } } })
  assert.equal(registrations[0].name, 'database-security-check')
  assert.match(registrations[0].content, /database_security_check/)
  assert.match(registrations[0].content, /不能说成安全/)
})
