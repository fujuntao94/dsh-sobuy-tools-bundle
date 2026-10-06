import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readDatabaseOptions } from '../index.js'
import { readConfig, writePrivateConfig } from '../src/storage/config-store.js'
import { normalizeDatabaseConfig, publicDatabaseStatus, setupHtml } from '../src/setup-page.js'

test('数据库设置页包含独立表单和一次性提交令牌', () => {
  const html = setupHtml({
    setupPath: '/database/setup',
    statusPath: '/database/status',
    setupToken: 'one-time-token',
  })
  assert.match(html, /name="host"/)
  assert.match(html, /name="port"/)
  assert.match(html, /name="database"/)
  assert.match(html, /name="username"/)
  assert.match(html, /name="password"/)
  assert.match(html, /name="allowed_tables"/)
  assert.match(html, /name="max_rows"/)
  assert.match(html, /name="query_timeout_ms"/)
  assert.match(html, /name="sensitive_fields"/)
  assert.match(html, /name="setup_token" value="one-time-token"/)
  assert.match(html, /fetch\('\/database\/status'/)
})

test('数据库状态不会向浏览器返回密码', () => {
  const status = publicDatabaseStatus({
    type: 'mysql', host: 'db.internal', port: 3306, database: 'orders', username: 'readonly', password: 'secret', ssl: true,
  })
  assert.deepEqual(status, {
    configured: true,
    type: 'mysql',
    host: 'db.internal',
    port: 3306,
    database: 'orders',
    username: 'readonly',
    passwordConfigured: true,
    ssl: true,
    allowedTables: [],
    maxRows: 500,
    queryTimeoutMs: 15000,
    sensitiveFields: ['password', 'passwd', 'secret', 'token', 'access_token', 'refresh_token', 'id_card', 'identity_number', 'mobile', 'phone', 'email'],
    tableAllowlistEnabled: false,
    arbitrarySqlAllowed: false,
    multipleStatementsAllowed: false,
    writeStatementsAllowed: false,
    queryLogsRedacted: true,
  })
  assert.equal('password' in status, false)
})

test('留空密码时复用已保存密码，并校验端口', () => {
  const normalized = normalizeDatabaseConfig({
    host: 'db.internal', port: '3307', database: 'orders', username: 'readonly', password: '', ssl: 'on',
  }, { password: 'saved-secret' })
  assert.equal(normalized.password, 'saved-secret')
  assert.equal(normalized.port, 3307)
  assert.equal(normalized.ssl, true)
  assert.deepEqual(normalized.allowedTables, [])
  assert.equal(normalized.maxRows, 500)
  assert.equal(normalized.queryTimeoutMs, 15000)
  assert.throws(() => normalizeDatabaseConfig({
    host: 'db.internal', port: '70000', database: 'orders', username: 'readonly', password: 'secret',
  }), /完整填写/)
  assert.equal(normalizeDatabaseConfig({
    host: 'db.internal', port: '3306', database: 'orders', username: 'readonly', password: ' spaced secret ',
  }).password, ' spaced secret ')
  const secured = normalizeDatabaseConfig({
    host: 'db.internal', port: '3306', database: 'orders', username: 'readonly', password: 'secret',
    allowedTables: 'orders\norder_items', maxRows: '50', queryTimeoutMs: '2500', sensitiveFields: 'password\nmobile',
  })
  assert.deepEqual(secured.allowedTables, ['orders', 'order_items'])
  assert.equal(secured.maxRows, 50)
  assert.equal(secured.queryTimeoutMs, 2500)
  assert.deepEqual(secured.sensitiveFields, ['password', 'mobile'])
})

test('数据库配置使用独立目录并以私有权限保存', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-database-tools-'))
  try {
    const value = { type: 'mysql', host: 'db.internal', port: 3306, database: 'orders', username: 'readonly', password: 'secret', ssl: false }
    await writePrivateConfig(value, folder)
    assert.deepEqual(await readConfig(folder), value)
    assert.equal((await stat(join(folder, 'config.json'))).mode & 0o777, 0o600)
    assert.match(await readFile(join(folder, 'config.json'), 'utf8'), /"password": "secret"/)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('数据库设置服务使用与 Desktop 入口一致的固定本机地址', () => {
  assert.throws(() => readDatabaseOptions({ setupPort: 18083 }), /固定本机协议/)
  assert.equal(readDatabaseOptions({}).setupPort, 18082)
  assert.equal(readDatabaseOptions({}).setupPath, '/database/setup')
})

test('Desktop 设置页提供独立的数据库入口', async () => {
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(client, /sobuy-database-tools/)
  assert.match(client, /plugins\.row\.config/)
  assert.match(client, /127\.0\.0\.1:18082\/database\/setup/)
  assert.match(client, /DatabaseSettings/)
})
