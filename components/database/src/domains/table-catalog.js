/**
 * 数据表目录查询。
 *
 * 这里只读取 information_schema.tables，不接收外部 SQL，也不读取业务表数据。
 */
import { runDatabaseOperation } from './connection.js'
import { resolveSecurityPolicy } from '../security/policy.js'

const TABLE_CATALOG_SQL = `
  SELECT TABLE_NAME AS tableName, TABLE_COMMENT AS tableComment
  FROM information_schema.tables
  WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
  ORDER BY TABLE_NAME
`

export function normalizeTableCatalog(rows) {
  const tables = Array.isArray(rows) ? rows.map(row => ({
    name: typeof row?.tableName === 'string' ? row.tableName : '',
    purpose: typeof row?.tableComment === 'string' && row.tableComment.trim()
      ? row.tableComment.trim()
      : '未填写表备注',
  })).filter(table => table.name) : []
  return { total: tables.length, tables }
}

/** 查询当前配置库中的基础表；视图不计入数据表数量。 */
export async function listDatabaseTables(config, { createConnection, signal } = {}) {
  return runDatabaseOperation(config, async connection => {
    const [rows] = await connection.execute(TABLE_CATALOG_SQL, [config.database])
    return normalizeTableCatalog(rows)
  }, { createConnection, signal, timeoutMs: resolveSecurityPolicy(config).queryTimeoutMs })
}
