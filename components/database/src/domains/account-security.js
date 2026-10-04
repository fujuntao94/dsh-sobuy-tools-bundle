import { runDatabaseOperation } from './connection.js'

const READ_ONLY_PRIVILEGES = new Set(['USAGE', 'SELECT', 'SHOW VIEW'])
const WRITE_PRIVILEGES = new Set([
  'ALTER', 'ALTER ROUTINE', 'CREATE', 'CREATE ROLE', 'CREATE ROUTINE', 'CREATE TABLESPACE',
  'CREATE TEMPORARY TABLES', 'CREATE USER', 'DELETE', 'DROP', 'EVENT', 'EXECUTE', 'FILE',
  'INDEX', 'INSERT', 'LOCK TABLES', 'REFERENCES', 'TRIGGER', 'UPDATE',
])

function grantStrings(rows) {
  return Array.isArray(rows)
    ? rows.flatMap(row => row && typeof row === 'object' ? Object.values(row) : []).filter(value => typeof value === 'string')
    : []
}

export function analyzeAccountGrants(rows) {
  const grants = grantStrings(rows)
  const writePrivileges = new Set()
  const reviewPrivileges = new Set()
  let roleGrantDetected = false

  for (const grant of grants) {
    if (/^GRANT\s+['`]/i.test(grant) && !/\sON\s/i.test(grant)) roleGrantDetected = true
    if (/WITH\s+GRANT\s+OPTION/i.test(grant)) writePrivileges.add('GRANT OPTION')
    const match = grant.match(/^GRANT\s+(.+?)\s+ON\s+/i)
    if (!match) continue
    for (const raw of match[1].split(',')) {
      const privilege = raw.trim().toUpperCase()
      if (privilege === 'ALL PRIVILEGES' || privilege === 'ALL') writePrivileges.add('ALL PRIVILEGES')
      else if (WRITE_PRIVILEGES.has(privilege)) writePrivileges.add(privilege)
      else if (!READ_ONLY_PRIVILEGES.has(privilege)) reviewPrivileges.add(privilege)
    }
  }

  if (writePrivileges.size) {
    return {
      status: 'writable', readOnlyVerified: false,
      writePrivileges: [...writePrivileges].sort(), reviewPrivileges: [...reviewPrivileges].sort(),
      reason: '账号具有写入或授权能力。',
    }
  }
  if (!grants.length || roleGrantDetected || reviewPrivileges.size) {
    return {
      status: 'unknown', readOnlyVerified: false,
      writePrivileges: [], reviewPrivileges: [...reviewPrivileges].sort(),
      reason: roleGrantDetected ? '账号使用角色授权，无法仅凭当前授权清单确认只读。' : '存在需要人工确认的权限。',
    }
  }
  return {
    status: 'read_only', readOnlyVerified: true, writePrivileges: [], reviewPrivileges: [],
    reason: '当前授权清单仅包含只读权限。',
  }
}

export async function checkReadonlyAccount(config, { createConnection, signal } = {}) {
  const [rows] = await runDatabaseOperation(
    config,
    connection => connection.query('SHOW GRANTS'),
    { createConnection, signal, timeoutMs: Number(config.queryTimeoutMs) || 5000 },
  )
  return analyzeAccountGrants(rows)
}
