import mysql from 'mysql2/promise'

export function databaseConnectionOptions(config) {
  return {
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database: config.database,
    ssl: config.ssl ? {} : undefined,
    connectTimeout: Math.min(Number(config.queryTimeoutMs) || 5000, 10000),
    // 驱动层固定禁止多语句，配置和调用方均不能打开。
    multipleStatements: false,
  }
}

function interruptionError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 在连接生命周期内执行固定操作，并统一处理取消、超时和连接释放。
 * operation 由组件内部提供，不接受模型或用户传入 SQL。
 */
export async function runDatabaseOperation(config, operation, {
  createConnection = mysql.createConnection,
  signal,
  timeoutMs = Number(config.queryTimeoutMs) || 5000,
} = {}) {
  if (signal?.aborted) throw interruptionError('DATABASE_QUERY_CANCELLED', '数据库查询已取消。')
  const connection = await createConnection(databaseConnectionOptions(config))
  let terminated = false
  let timer
  let abort
  const interrupt = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      terminated = true
      connection.destroy()
      reject(interruptionError('DATABASE_QUERY_TIMEOUT', '数据库查询超时。'))
    }, timeoutMs)
    abort = () => {
      terminated = true
      connection.destroy()
      reject(interruptionError('DATABASE_QUERY_CANCELLED', '数据库查询已取消。'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })

  try {
    if (signal?.aborted) abort()
    return await Promise.race([operation(connection), interrupt])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (!terminated) await connection.end()
  }
}
