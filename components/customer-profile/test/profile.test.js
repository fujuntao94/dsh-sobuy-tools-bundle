import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertDshToolSchema, assertDshToolValue } from 'sobuy-plugin-core/schema'
import { decryptOmsText } from '../src/domains/aes-gcm.js'
import { buildCustomerProfileQueries } from '../src/domains/customer-profile.js'
import { createCustomerProfileTool } from '../src/runtime/tools/customer-profile-tool.js'
import { writeSourceConfig } from '../src/storage/config-store.js'

function encryptForTest(value, secret) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret, 'utf8').digest(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64')
}

test('OMS AES-GCM 解密兼容 Java 的 IV、密文与认证标签排列', () => {
  const secret = 'test-only-key'
  assert.equal(decryptOmsText(encryptForTest('Ada Lovelace', secret), secret), 'Ada Lovelace')
  assert.equal(decryptOmsText('plaintext', secret), 'plaintext')
  assert.equal(decryptOmsText(encryptForTest('Ada Lovelace', secret), 'wrong-key'), null)
})

test('客户画像只固定读取订单、商品和履约三张表', () => {
  const built = buildCustomerProfileQueries({ customer_id: 'customer-1' })
  assert.deepEqual(built.summary.values, ['customer-1'])
  assert.match(built.summary.sql, /FROM oms_t_orders/)
  assert.match(built.products.sql, /oms_t_orders_product/)
  assert.match(built.destinations.sql, /oms_t_orders_tracking/)
  assert.throws(() => buildCustomerProfileQueries({ customer_id: 'x', sql: 'SELECT 1' }), /不支持/)
})

test('客户画像 Tool 默认隐藏联系资料，显式授权后才返回本机解密结果', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-customer-profile-'))
  try {
    const secret = 'test-only-key'
    const encrypted = encryptForTest('Ada Lovelace', secret)
    const profile = async () => ({ raw: { customer_id: 'c-1', is_encryption: 1, customer_account: encrypted, nickname: encrypted, email: encrypted, recipient_name: encrypted, phone: encrypted, shipping_country: encrypted, shipping_city: encrypted }, spending: [], products: [], destinations: [], metrics: { firstOrderAt: null, lastOrderAt: null, orderCount: 2, afterSaleOrderCount: 0, cancellationIntentCount: 0, regularCustomer: true } })
    const tool = createCustomerProfileTool({ dataDirectory: folder, profile })
    assertDshToolSchema(tool.output.schema)
    await writeSourceConfig({ version: 1, sources: [{ host: 'db', port: 3306, database: 'oms', username: 'read', password: 'password' }], encryptionKey: secret, allowPiiOutput: false }, folder)
    const hidden = await tool.execute({ customer_id: 'c-1' })
    assert.equal(hidden.contact.email, null)
    await writeSourceConfig({ version: 1, sources: [{ host: 'db', port: 3306, database: 'oms', username: 'read', password: 'password' }], encryptionKey: secret, allowPiiOutput: true }, folder)
    const revealed = await tool.execute({ customer_id: 'c-1' })
    assert.equal(revealed.contact.email, 'Ada Lovelace')
    assert.doesNotThrow(() => assertDshToolValue(tool.output.schema, revealed))
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
