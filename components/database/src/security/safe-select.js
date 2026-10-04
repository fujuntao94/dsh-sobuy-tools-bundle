import { runDatabaseOperation } from '../domains/connection.js'
import { errorKind } from './query-audit.js'
import { maskSensitiveRows } from './sensitive-fields.js'
import { resolveSecurityPolicy } from './policy.js'

const QUERY_FIELDS = new Set(['table', 'columns', 'conditions', 'limit'])

function quoteIdentifier(value, label) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 64 || /[\0-\x1f\x7f]/.test(name)) throw new Error(`${label}无效。`)
  return `\`${name.replaceAll('`', '``')}\``
}

export function buildSafeSelect(query, config = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('只读查询参数无效。')
  const unknownFields = Object.keys(query).filter(key => !QUERY_FIELDS.has(key))
  if (unknownFields.length) throw new Error(`只读查询不支持参数：${unknownFields.join('、')}。`)

  const policy = resolveSecurityPolicy(config)
  const table = typeof query.table === 'string' ? query.table.trim() : ''
  if (!policy.allowedTables.includes(table)) throw new Error(`数据表 ${table || '（空）'} 不在白名单中。`)

  const columns = Array.isArray(query.columns) && query.columns.length ? query.columns : ['*']
  const projection = columns.length === 1 && columns[0] === '*'
    ? '*'
    : columns.map(column => quoteIdentifier(column, '字段名')).join(', ')
  const conditions = query.conditions && typeof query.conditions === 'object' && !Array.isArray(query.conditions)
    ? Object.entries(query.conditions)
    : []
  const values = []
  const where = conditions.length
    ? ` WHERE ${conditions.map(([column, value]) => {
      values.push(value)
      return `${quoteIdentifier(column, '筛选字段')} = ?`
    }).join(' AND ')}`
    : ''
  const requestedLimit = Number.isInteger(Number(query.limit)) && Number(query.limit) > 0
    ? Number(query.limit)
    : policy.maxRows
  const appliedLimit = Math.min(requestedLimit, policy.maxRows)
  values.push(appliedLimit)

  return {
    sql: `SELECT ${projection} FROM ${quoteIdentifier(table, '表名')}${where} LIMIT ?`,
    values,
    meta: {
      table,
      columnCount: columns[0] === '*' ? 0 : columns.length,
      conditionCount: conditions.length,
      appliedLimit,
    },
  }
}

/** 结构化只读查询服务：调用方不能提交 SQL，因此不存在写入或多语句入口。 */
export async function executeSafeSelect(config, query, {
  createConnection,
  signal,
  auditLogger,
  now = Date.now,
} = {}) {
  const startedAt = now()
  let built
  try {
    built = buildSafeSelect(query, config)
    const [rows] = await runDatabaseOperation(
      config,
      connection => connection.execute(built.sql, built.values),
      { createConnection, signal, timeoutMs: resolveSecurityPolicy(config).queryTimeoutMs },
    )
    const maskedRows = maskSensitiveRows(rows, config)
    auditLogger?.record({
      operation: 'select', status: 'success', ...built.meta,
      rowCount: maskedRows.length, durationMs: Math.max(0, now() - startedAt),
    })
    return { rows: maskedRows, rowCount: maskedRows.length, limit: built.meta.appliedLimit }
  } catch (error) {
    const kind = errorKind(error)
    auditLogger?.record({
      operation: 'select', status: 'error', ...(built?.meta || {}),
      durationMs: Math.max(0, now() - startedAt), errorKind: kind,
    })
    if (!built || error?.code === 'DATABASE_QUERY_TIMEOUT' || error?.code === 'DATABASE_QUERY_CANCELLED') throw error
    const publicError = new Error('安全只读查询失败，请检查连接、权限和查询条件。')
    publicError.code = kind === 'authentication'
      ? 'DATABASE_AUTHENTICATION_FAILED'
      : kind === 'permission' ? 'DATABASE_PERMISSION_DENIED' : 'DATABASE_QUERY_FAILED'
    throw publicError
  }
}
