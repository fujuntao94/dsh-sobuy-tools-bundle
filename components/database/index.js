// 数据库组件提供独立设置页，以及只读的数据表目录 Tool 与 Skill。
import { defaultDataDirectory } from './src/storage/config-store.js'
import { createDatabaseSetupServer } from './src/setup-page.js'
import { registerListTablesTool } from './src/runtime/tools/list-tables-tool.js'
import { registerDescribeTableTool } from './src/runtime/tools/describe-table-tool.js'
import { registerSoldoutAttributionTool } from './src/runtime/tools/soldout-attribution-tool.js'
import { registerInventoryShortageForecastTool } from './src/runtime/tools/inventory-shortage-forecast-tool.js'
import { registerSoldoutSnapshotTools } from './src/runtime/tools/soldout-snapshot-tool.js'
import { registerDictionaryTool } from './src/runtime/tools/dictionary-tool.js'
import { registerOrderTimelineTool } from './src/runtime/tools/order-timeline-tool.js'
import { registerTableCatalogSkill } from './src/runtime/skills/table-catalog-skill.js'
import { registerSoldoutAttributionSkill } from './src/runtime/skills/soldout-attribution-skill.js'
import { registerDictionarySkill } from './src/runtime/skills/dictionary-skill.js'
import { registerOrderTimelineSkill } from './src/runtime/skills/order-timeline-skill.js'
import { createQueryAuditLogger } from './src/security/query-audit.js'
import { provideDatabaseSecurityService } from './src/runtime/services/database-security-service.js'
import { registerSecurityCheckTool } from './src/runtime/tools/security-check-tool.js'
import { registerSecurityCheckSkill } from './src/runtime/skills/security-check-skill.js'
import { areDistinctAbsolutePaths, isLoopbackHost, isValidPort } from 'sobuy-plugin-core/loopback'

export const name = 'dsh-sobuy-database-tools'
export const inject = ['tools', 'skills']
const SETUP_ENDPOINT = Object.freeze({
  host: '127.0.0.1',
  port: 18082,
  path: '/database/setup',
  statusPath: '/database/status',
})

export function readDatabaseOptions(config = {}) {
  if (['setupHost', 'setupPort', 'setupPath', 'statusPath'].some(key => config[key] !== undefined)) {
    throw new Error('数据库设置页地址为固定本机协议，不能通过插件配置覆盖。')
  }
  const options = {
    setupHost: SETUP_ENDPOINT.host,
    setupPort: SETUP_ENDPOINT.port,
    setupPath: SETUP_ENDPOINT.path,
    statusPath: SETUP_ENDPOINT.statusPath,
    dataDirectory: config.dataDirectory || defaultDataDirectory(),
  }
  if (!isValidPort(options.setupPort) || !isLoopbackHost(options.setupHost)
    || !areDistinctAbsolutePaths([options.setupPath, options.statusPath])) {
    throw new Error('数据库组件的本机设置页端口或路径配置无效。')
  }
  return options
}

export function apply(ctx, config = {}) {
  const options = readDatabaseOptions(config)
  const auditLogger = createQueryAuditLogger(ctx.logger)
  const securityService = provideDatabaseSecurityService(ctx, { ...options, auditLogger })
  const setupPage = createDatabaseSetupServer({ ...options, logger: ctx.logger })
  void setupPage.ready.catch(error => ctx.logger?.warn('数据库设置页未启动：%s', error.message))
  ctx.effect(() => () => setupPage.close(), 'sobuy-database-tools: setup page server')
  registerListTablesTool(ctx, { ...options, auditLogger })
  registerDescribeTableTool(ctx, { ...options, auditLogger })
  registerSoldoutAttributionTool(ctx, { ...options, auditLogger })
  registerInventoryShortageForecastTool(ctx, { ...options, auditLogger })
  registerSoldoutSnapshotTools(ctx, { ...options, auditLogger })
  registerDictionaryTool(ctx, { ...options, auditLogger })
  registerOrderTimelineTool(ctx, { ...options, auditLogger })
  registerSecurityCheckTool(ctx, { securityService })
  registerTableCatalogSkill(ctx)
  registerSoldoutAttributionSkill(ctx)
  registerDictionarySkill(ctx)
  registerOrderTimelineSkill(ctx)
  registerSecurityCheckSkill(ctx)
}
