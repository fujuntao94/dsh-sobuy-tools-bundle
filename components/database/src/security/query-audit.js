const ALLOWED_FIELDS = [
  'operation', 'status', 'table', 'columnCount', 'conditionCount', 'appliedLimit',
  'rowCount', 'durationMs', 'errorKind',
]

export function redactQueryAuditEvent(event = {}) {
  const safe = { component: 'sobuy-database-tools' }
  for (const field of ALLOWED_FIELDS) {
    const value = event[field]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') safe[field] = value
  }
  return safe
}

/** 日志采用字段白名单，从结构上排除 SQL、参数、结果、凭据和驱动错误原文。 */
export function createQueryAuditLogger(logger) {
  return {
    record(event) {
      const safe = redactQueryAuditEvent(event)
      const method = safe.status === 'error' ? 'warn' : 'info'
      logger?.[method]?.(safe)
      return safe
    },
  }
}

export function errorKind(error) {
  if (error?.code === 'DATABASE_QUERY_TIMEOUT') return 'timeout'
  if (error?.code === 'DATABASE_QUERY_CANCELLED') return 'cancelled'
  if (error?.code === 'ER_ACCESS_DENIED_ERROR') return 'authentication'
  if (error?.code === 'ER_DBACCESS_DENIED_ERROR' || error?.code === 'ER_TABLEACCESS_DENIED_ERROR') return 'permission'
  return 'query_failed'
}
