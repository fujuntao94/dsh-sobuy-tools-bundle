/**
 * 数据表结构查询。
 *
 * 仅从 information_schema.columns 读取元数据，不查询业务表记录，也不接收 SQL。
 */
import { runDatabaseOperation } from './connection.js'
import { resolveSecurityPolicy } from '../security/policy.js'

const TABLE_SCHEMA_SQL = `
  SELECT
    COLUMN_NAME AS columnName,
    COLUMN_TYPE AS columnType,
    IS_NULLABLE AS nullable,
    COLUMN_KEY AS columnKey,
    COLUMN_COMMENT AS columnComment
  FROM information_schema.columns
  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
  ORDER BY ORDINAL_POSITION
`

export function normalizeTableName(value) {
  const raw = typeof value === 'string' ? value : ''
  const table = raw.trim()
  if (!table || table.length > 64 || /[\0-\x1f\x7f]/.test(raw)) {
    throw new Error('数据表名称无效。')
  }
  return table
}

export function normalizeTableSchema(table, rows) {
  const columns = Array.isArray(rows) ? rows.map(row => ({
    name: typeof row?.columnName === 'string' ? row.columnName : '',
    type: typeof row?.columnType === 'string' ? row.columnType : '',
    nullable: row?.nullable === 'YES',
    key: typeof row?.columnKey === 'string' ? row.columnKey : '',
    comment: typeof row?.columnComment === 'string' && row.columnComment.trim()
      ? row.columnComment.trim()
      : '未填写字段备注',
  })).filter(column => column.name && column.type) : []
  return { table, total: columns.length, columns }
}

/** 查询指定表的字段元数据；表名通过参数传给 information_schema，不拼接至 SQL。 */
export async function describeDatabaseTable(config, tableName, { createConnection, signal } = {}) {
  const table = normalizeTableName(tableName)
  return runDatabaseOperation(config, async connection => {
    const [rows] = await connection.execute(TABLE_SCHEMA_SQL, [config.database, table])
    return normalizeTableSchema(table, rows)
  }, { createConnection, signal, timeoutMs: resolveSecurityPolicy(config).queryTimeoutMs })
}
