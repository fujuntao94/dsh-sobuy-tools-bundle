export const DEFAULT_SENSITIVE_FIELDS = [
  'password', 'passwd', 'secret', 'token', 'access_token', 'refresh_token',
  'id_card', 'identity_number', 'mobile', 'phone', 'email',
]

export const DEFAULT_SECURITY_POLICY = Object.freeze({
  maxRows: 500,
  queryTimeoutMs: 15000,
  sensitiveFields: DEFAULT_SENSITIVE_FIELDS,
})

function list(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : []
  return [...new Set(values.map(item => String(item).trim()).filter(Boolean))]
}

function safeIdentifierList(value, { maxItems, fallback = [] }) {
  const values = list(value)
  if (!values.length) return fallback
  return values
    .filter(item => item.length <= 64 && !/[\0-\x1f\x7f]/.test(item))
    .slice(0, maxItems)
}

function configuredIdentifierList(value, { label, maxItems, fallback = [] }) {
  const values = list(value)
  if (!values.length) return fallback
  if (values.length > maxItems) throw new Error(`${label}最多允许配置 ${maxItems} 项。`)
  if (values.some(item => item.length > 64 || /[\0-\x1f\x7f]/.test(item))) {
    throw new Error(`${label}包含无效名称。`)
  }
  return values
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback
}

/** 读取磁盘配置时采用安全默认值，手工篡改配置也不能放大限制。 */
export function resolveSecurityPolicy(config = {}) {
  return {
    maxRows: boundedInteger(config.maxRows, DEFAULT_SECURITY_POLICY.maxRows, 1, 5000),
    queryTimeoutMs: boundedInteger(config.queryTimeoutMs, DEFAULT_SECURITY_POLICY.queryTimeoutMs, 500, 60000),
    sensitiveFields: safeIdentifierList(config.sensitiveFields, {
      maxItems: 100,
      fallback: DEFAULT_SENSITIVE_FIELDS,
    }),
  }
}

/** 设置页保存时严格校验，避免用户误以为超出安全边界的值已经生效。 */
export function normalizeSecurityPolicy(input = {}, previous = {}) {
  const sensitiveFields = input.sensitiveFields === undefined
    ? resolveSecurityPolicy(previous).sensitiveFields
    : configuredIdentifierList(input.sensitiveFields, { label: '敏感字段规则', maxItems: 100, fallback: DEFAULT_SENSITIVE_FIELDS })
  const maxRows = input.maxRows === undefined
    ? resolveSecurityPolicy(previous).maxRows
    : Number(input.maxRows)
  const queryTimeoutMs = input.queryTimeoutMs === undefined
    ? resolveSecurityPolicy(previous).queryTimeoutMs
    : Number(input.queryTimeoutMs)

  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 5000) {
    throw new Error('最大返回行数必须是 1 到 5000 之间的整数。')
  }
  if (!Number.isInteger(queryTimeoutMs) || queryTimeoutMs < 500 || queryTimeoutMs > 60000) {
    throw new Error('查询超时必须是 500 到 60000 毫秒之间的整数。')
  }
  return { maxRows, queryTimeoutMs, sensitiveFields }
}

export function publicSecurityPolicy(config = {}) {
  const policy = resolveSecurityPolicy(config)
  return {
    ...policy,
    arbitrarySqlAllowed: false,
    multipleStatementsAllowed: false,
    writeStatementsAllowed: false,
    queryLogsRedacted: true,
  }
}
