// 数据库组件提供独立设置页，以及只读的数据表目录 Tool 与 Skill。
import { defaultDataDirectory } from './src/storage/config-store.js'
import { createDatabaseSetupServer } from './src/setup-page.js'
import { registerListTablesTool } from './src/runtime/tools/list-tables-tool.js'
import { registerTableCatalogSkill } from './src/runtime/skills/table-catalog-skill.js'
import { createQueryAuditLogger } from './src/security/query-audit.js'
import { provideDatabaseSecurityService } from './src/runtime/services/database-security-service.js'
import { registerSecurityCheckTool } from './src/runtime/tools/security-check-tool.js'
import { registerSecurityCheckSkill } from './src/runtime/skills/security-check-skill.js'

export const name = 'dsh-sobuy-database-tools'
export const inject = ['tools', 'skills']

export function readDatabaseOptions(config = {}) {
  const options = {
    setupHost: config.setupHost || '127.0.0.1',
    setupPort: Number(config.setupPort || 18082),
    setupPath: config.setupPath || '/database/setup',
    statusPath: config.statusPath || '/database/status',
    dataDirectory: config.dataDirectory || defaultDataDirectory(),
  }
  const invalidPort = !Number.isInteger(options.setupPort) || options.setupPort < 1 || options.setupPort > 65535
  const invalidPaths = [options.setupPath, options.statusPath].some(path => !path.startsWith('/'))
    || options.setupPath === options.statusPath
  if (invalidPort || !['127.0.0.1', '::1'].includes(options.setupHost) || invalidPaths) {
    throw new Error('数据库组件的本机设置页端口或路径配置无效。')
  }
  return options
}

export function apply(ctx, config = {}) {
  const options = readDatabaseOptions(config)
  const auditLogger = createQueryAuditLogger(ctx.logger)
  const securityService = provideDatabaseSecurityService(ctx, { ...options, auditLogger })
  const setupPage = createDatabaseSetupServer(options)
  void setupPage.ready.catch(error => ctx.logger?.warn('数据库设置页未启动：%s', error.message))
  ctx.effect(() => () => setupPage.close(), 'sobuy-database-tools: setup page server')
  registerListTablesTool(ctx, { ...options, auditLogger })
  registerSecurityCheckTool(ctx, { securityService })
  registerTableCatalogSkill(ctx)
  registerSecurityCheckSkill(ctx)
}
