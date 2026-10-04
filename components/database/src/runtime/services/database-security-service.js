import { checkReadonlyAccount } from '../../domains/account-security.js'
import { readConfig } from '../../storage/config-store.js'
import { executeSafeSelect } from '../../security/safe-select.js'
import { publicSecurityPolicy } from '../../security/policy.js'
import { errorKind } from '../../security/query-audit.js'

function configured(config) {
  return Boolean(config?.host && config?.port && config?.database && config?.username && config?.password)
}

export function createDatabaseSecurityService({ dataDirectory, auditLogger }) {
  async function loadConfig() {
    const config = await readConfig(dataDirectory)
    if (!configured(config)) throw new Error('请先在数据库设置页保存完整连接信息。')
    return config
  }

  return {
    async policy() {
      return publicSecurityPolicy(await loadConfig())
    },
    async checkReadonly({ signal } = {}) {
      const startedAt = Date.now()
      try {
        const result = await checkReadonlyAccount(await loadConfig(), { signal })
        auditLogger?.record({
          operation: 'readonly_check', status: 'success', rowCount: 0,
          durationMs: Math.max(0, Date.now() - startedAt),
        })
        return result
      } catch (error) {
        auditLogger?.record({
          operation: 'readonly_check', status: 'error', errorKind: errorKind(error),
          durationMs: Math.max(0, Date.now() - startedAt),
        })
        throw error
      }
    },
    async select(query, { signal, createConnection } = {}) {
      return executeSafeSelect(await loadConfig(), query, { signal, createConnection, auditLogger })
    },
  }
}

export function provideDatabaseSecurityService(ctx, options) {
  const service = createDatabaseSecurityService(options)
  ctx.provide?.('databaseSecurity', service)
  return service
}
