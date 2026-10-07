import { nullableSchema } from 'sobuy-plugin-core/schema'
import { decryptOmsText } from '../../domains/aes-gcm.js'
import { queryCustomerProfile } from '../../domains/customer-profile.js'
import { readSourceConfig } from '../../storage/config-store.js'

const STRING = { type: 'string' }
const NUMBER = { type: 'number' }

function configured(config) {
  return Boolean(config?.sources?.[0]?.host && config.sources[0].port && config.sources[0].database && config.sources[0].username && config.sources[0].password)
}

function identity(raw, config) {
  const reveal = Boolean(config.allowPiiOutput)
  const decrypt = value => reveal ? decryptOmsText(value, config.encryptionKey) : null
  return {
    account: decrypt(raw.customer_account), nickname: decrypt(raw.nickname), email: decrypt(raw.email),
    recipientName: decrypt(raw.recipient_name), phone: decrypt(raw.phone),
    shippingCountry: decrypt(raw.shipping_country), shippingCity: decrypt(raw.shipping_city),
  }
}

const CONTACT = {
  type: 'object', additionalProperties: false,
  required: ['account', 'nickname', 'email', 'recipientName', 'phone', 'shippingCountry', 'shippingCity'],
  properties: {
    account: nullableSchema('string', '客户账号。'), nickname: nullableSchema('string', '客户昵称。'), email: nullableSchema('string', '客户邮箱。'), recipientName: nullableSchema('string', '收货人姓名。'),
    phone: nullableSchema('string', '收货电话。'), shippingCountry: nullableSchema('string', '收货国家。'), shippingCity: nullableSchema('string', '收货城市。'),
  },
}

export function createCustomerProfileTool({ dataDirectory, profile = queryCustomerProfile, auditLogger } = {}) {
  return {
    name: 'customer_profile_lookup',
    description: '根据 OMS customer_id 生成客户画像。只读取固定的订单、订单商品和履约表；仅在本机已配置且明确授权后解密、返回客户联系资料，不接受 SQL 或任意表名。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['customer_id'],
      properties: { customer_id: { type: 'string', minLength: 1, maxLength: 50, description: 'OMS 订单表中的 cust_id。' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        required: ['customerId', 'contact', 'metrics', 'spending', 'topProducts', 'destinations', 'privacy', 'note'],
        properties: {
          customerId: STRING, contact: CONTACT,
          metrics: { type: 'object', additionalProperties: false, required: ['firstOrderAt', 'lastOrderAt', 'orderCount', 'afterSaleOrderCount', 'cancellationIntentCount', 'regularCustomer'], properties: { firstOrderAt: nullableSchema('string', '首单时间。'), lastOrderAt: nullableSchema('string', '最近下单时间。'), orderCount: NUMBER, afterSaleOrderCount: NUMBER, cancellationIntentCount: NUMBER, regularCustomer: { type: 'boolean' } } },
          spending: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['currency', 'paidAmount', 'refundAmount'], properties: { currency: STRING, paidAmount: NUMBER, refundAmount: NUMBER } } },
          topProducts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['sku', 'name', 'quantity', 'orderCount'], properties: { sku: STRING, name: nullableSchema('string', '商品名称。'), quantity: NUMBER, orderCount: NUMBER } } },
          destinations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['country', 'orderCount', 'receivedCount', 'exceptionCount'], properties: { country: STRING, orderCount: NUMBER, receivedCount: NUMBER, exceptionCount: NUMBER } } },
          privacy: { type: 'object', additionalProperties: false, required: ['sourceEncrypted', 'keyConfigured', 'piiOutputEnabled'], properties: { sourceEncrypted: { type: 'boolean' }, keyConfigured: { type: 'boolean' }, piiOutputEnabled: { type: 'boolean' } } },
          note: STRING,
        },
      },
      render: (_args, value) => [{ type: 'text', text: `客户 ${value.customerId}：累计 ${value.metrics.orderCount} 单，售后订单 ${value.metrics.afterSaleOrderCount}，取消意向 ${value.metrics.cancellationIntentCount}。\n首单：${value.metrics.firstOrderAt || '无'}；最近下单：${value.metrics.lastOrderAt || '无'}。\n按币种金额：${value.spending.map(item => `${item.currency} 已付 ${item.paidAmount}，退款 ${item.refundAmount}`).join('；') || '无'}。\n常购商品：${value.topProducts.map(item => `${item.sku} × ${item.quantity}`).join('；') || '无'}。\n${value.note}` }],
    },
    async execute(args, exec) {
      const startedAt = Date.now()
      if (exec?.signal?.aborted) throw new Error('客户画像查询已取消。')
      const config = await readSourceConfig(dataDirectory)
      if (!configured(config)) throw new Error('请先在客户画像设置页保存完整的只读数据库连接。')
      try {
        const result = await profile(config.sources[0], args, { signal: exec?.signal })
        if (!result) throw new Error('未找到该 customer_id 的有效订单。')
        const sourceEncrypted = Number(result.raw.is_encryption) === 1
        const value = {
          customerId: String(result.raw.customer_id), contact: identity(result.raw, config), metrics: result.metrics, spending: result.spending,
          topProducts: result.products, destinations: result.destinations,
          privacy: { sourceEncrypted, keyConfigured: Boolean(config.encryptionKey), piiOutputEnabled: Boolean(config.allowPiiOutput) },
          note: config.allowPiiOutput
            ? '身份与联系方式仅从订单主表的固定字段读取；疑似密文仅在本机使用配置密钥解密，认证失败或缺少密钥的字段返回空值。'
            : '未启用个人资料输出，联系方式已隐藏。可在客户画像设置页显式授权后查看。',
        }
        auditLogger?.record({ operation: 'customer_profile_lookup', status: 'success', table: 'oms_t_orders', rowCount: result.metrics.orderCount, durationMs: Date.now() - startedAt })
        return value
      } catch (error) {
        auditLogger?.record({ operation: 'customer_profile_lookup', status: 'error', table: 'oms_t_orders', durationMs: Date.now() - startedAt })
        if (exec?.signal?.aborted) throw new Error('客户画像查询已取消。')
        if (/customer_id|参数|未找到/.test(String(error?.message))) throw error
        throw new Error('无法读取客户画像，请检查客户画像数据源、网络和只读账号权限。')
      }
    },
  }
}

export function registerCustomerProfileTool(ctx, options) {
  return ctx.tools.register(createCustomerProfileTool(options))
}
