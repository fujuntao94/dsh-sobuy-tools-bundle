import { resolveSecurityPolicy } from './policy.js'

function normalizedName(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

export function isSensitiveField(name, configuredFields) {
  const normalized = normalizedName(name)
  return configuredFields.some(field => {
    const target = normalizedName(field)
    return normalized === target
      || normalized.startsWith(`${target}_`)
      || normalized.endsWith(`_${target}`)
      || normalized.includes(`_${target}_`)
  })
}

function maskValue(value, sensitiveFields) {
  if (Array.isArray(value)) return value.map(item => maskValue(item, sensitiveFields))
  if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    isSensitiveField(key, sensitiveFields) ? '[REDACTED]' : maskValue(item, sensitiveFields),
  ]))
}

export function maskSensitiveRows(rows, config = {}) {
  const { sensitiveFields } = resolveSecurityPolicy(config)
  return Array.isArray(rows) ? rows.map(row => maskValue(row, sensitiveFields)) : []
}
