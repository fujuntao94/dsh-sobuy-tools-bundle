/**
 * 一次性脚本：导出当前配置库的全部表、字段与注释。
 * 只读 information_schema，不触碰业务数据。输出 JSON + Markdown。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import mysql from 'mysql2/promise'

const configPath = join(homedir(), '.dsh', 'database-tools', 'config.json')
const config = JSON.parse(await readFile(configPath, 'utf8'))

const outDir = join(process.cwd(), 'dist', 'db-dictionary')
await mkdir(outDir, { recursive: true })

const connection = await mysql.createConnection({
  host: config.host,
  port: config.port,
  user: config.username,
  password: config.password,
  database: config.database,
  ssl: config.ssl ? {} : undefined,
  connectTimeout: 10000,
  multipleStatements: false,
})

try {
  const [tables] = await connection.execute(
    `SELECT TABLE_NAME AS tableName, TABLE_COMMENT AS tableComment, TABLE_ROWS AS tableRows,
            ENGINE AS engine, TABLE_COLLATION AS collation
     FROM information_schema.tables
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`,
    [config.database],
  )

  const [columns] = await connection.execute(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType,
            IS_NULLABLE AS nullable, COLUMN_KEY AS columnKey, COLUMN_DEFAULT AS columnDefault,
            COLUMN_COMMENT AS columnComment, ORDINAL_POSITION AS position
     FROM information_schema.columns
     WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [config.database],
  )

  const [views] = await connection.execute(
    `SELECT TABLE_NAME AS tableName
     FROM information_schema.views WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [config.database],
  )

  const byTable = new Map()
  for (const c of columns) {
    if (!byTable.has(c.tableName)) byTable.set(c.tableName, [])
    byTable.get(c.tableName).push(c)
  }

  const result = {
    generatedAt: new Date().toISOString(),
    connection: {
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.username,
    },
    allowedTables: config.allowedTables ?? [],
    totalTables: tables.length,
    totalViews: views.length,
    totalColumns: columns.length,
    tables: tables.map(t => ({
      name: t.tableName,
      comment: t.tableComment && t.tableComment.trim() ? t.tableComment.trim() : '未填写表备注',
      rows: Number(t.tableRows) || 0,
      engine: t.engine || '',
      whitelisted: (config.allowedTables ?? []).includes(t.tableName),
      columns: (byTable.get(t.tableName) ?? []).map(c => ({
        name: c.columnName,
        type: c.columnType,
        nullable: c.nullable === 'YES',
        key: c.columnKey || '',
        default: c.columnDefault,
        comment: c.columnComment && c.columnComment.trim() ? c.columnComment.trim() : '',
      })),
    })),
    views: views.map(v => ({
      name: v.tableName,
    })),
  }

  await writeFile(join(outDir, 'db-dictionary.json'), JSON.stringify(result, null, 2), 'utf8')

  // Markdown
  const lines = []
  lines.push(`# ${config.database} 数据库表字典`)
  lines.push('')
  lines.push(`- 导出时间：${result.generatedAt}`)
  lines.push(`- 连接：${config.host}:${config.port} / ${config.database}（${config.username}）`)
  lines.push(`- 基础表 ${result.totalTables} 张，视图 ${result.totalViews} 个，字段合计 ${result.totalColumns} 个`)
  lines.push('')
  lines.push('## 表清单')
  lines.push('')
  lines.push('| # | 表名 | 表说明 | 字段数 | 估算行数 | 白名单 |')
  lines.push('|---|------|--------|--------|----------|--------|')
  result.tables.forEach((t, i) => {
    lines.push(`| ${i + 1} | \`${t.name}\` | ${t.comment} | ${t.columns.length} | ${t.rows} | ${t.whitelisted ? '✅' : ''} |`)
  })
  lines.push('')
  if (result.views.length) {
    lines.push('## 视图')
    lines.push('')
    result.views.forEach(v => lines.push(`- \`${v.name}\``))
    lines.push('')
  }
  lines.push('## 字段明细')
  lines.push('')
  for (const t of result.tables) {
    lines.push(`### ${t.name}`)
    lines.push('')
    lines.push(`> ${t.comment}`)
    lines.push('')
    lines.push('| 字段名 | 类型 | 可空 | 键 | 默认值 | 字段说明 |')
    lines.push('|--------|------|------|----|--------|----------|')
    for (const c of t.columns) {
      const def = c.default === null || c.default === undefined ? '' : String(c.default)
      lines.push(`| \`${c.name}\` | ${c.type} | ${c.nullable ? 'YES' : 'NO'} | ${c.key} | ${def} | ${c.comment} |`)
    }
    lines.push('')
  }

  await writeFile(join(outDir, 'db-dictionary.md'), lines.join('\n'), 'utf8')
  console.log(JSON.stringify({
    ok: true,
    tables: result.totalTables,
    views: result.totalViews,
    columns: result.totalColumns,
    outDir,
  }, null, 2))
} finally {
  await connection.end()
}
