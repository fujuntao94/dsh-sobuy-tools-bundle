import mysql from 'mysql2/promise'

export async function runDatabaseOperation(config, operation, { createConnection = mysql.createConnection, signal, timeoutMs = 10000 } = {}) {
  if (signal?.aborted) throw new Error('客户画像查询已取消。')
  const connection = await createConnection({ host: config.host, port: config.port, user: config.username, password: config.password, database: config.database, ssl: config.ssl ? {} : undefined, connectTimeout: Math.min(timeoutMs, 10000), multipleStatements: false })
  let closed = false
  const timer = setTimeout(() => { closed = true; connection.destroy() }, timeoutMs)
  try {
    if (signal?.aborted) throw new Error('客户画像查询已取消。')
    return await operation(connection)
  } finally {
    clearTimeout(timer)
    if (!closed) await connection.end()
  }
}
