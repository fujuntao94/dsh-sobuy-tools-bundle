import { registerCustomerProfileTool } from './src/runtime/tools/customer-profile-tool.js'
import { registerCustomerProfileSkill } from './src/runtime/skills/customer-profile-skill.js'
import { createCustomerProfileSetupServer } from './src/setup-page.js'
import { defaultDataDirectory } from './src/storage/config-store.js'
import { areDistinctAbsolutePaths, isLoopbackHost, isValidPort } from 'sobuy-plugin-core/loopback'

// 独立组件：客户画像的数据源、权限和 PII 策略不会耦合到 OMS 数据库组件。
export const name = 'dsh-sobuy-customer-profile-tools'
export const inject = ['tools', 'skills']

const SETUP_ENDPOINT = Object.freeze({ host: '127.0.0.1', port: 18083, path: '/customer-profile/setup', statusPath: '/customer-profile/status' })

export function readCustomerProfileOptions(config = {}) {
  if (['setupHost', 'setupPort', 'setupPath', 'statusPath'].some(key => config[key] !== undefined)) throw new Error('客户画像设置页地址为固定本机协议，不能通过插件配置覆盖。')
  const options = { setupHost: SETUP_ENDPOINT.host, setupPort: SETUP_ENDPOINT.port, setupPath: SETUP_ENDPOINT.path, statusPath: SETUP_ENDPOINT.statusPath, dataDirectory: config.dataDirectory || defaultDataDirectory() }
  if (!isValidPort(options.setupPort) || !isLoopbackHost(options.setupHost) || !areDistinctAbsolutePaths([options.setupPath, options.statusPath])) throw new Error('客户画像设置页地址无效。')
  return options
}

export function apply(ctx, config = {}) {
  const options = readCustomerProfileOptions(config)
  const setupPage = createCustomerProfileSetupServer({ ...options, logger: ctx.logger })
  void setupPage.ready.catch(error => ctx.logger?.warn('客户画像设置页未启动：%s', error.message))
  ctx.effect(() => () => setupPage.close(), 'sobuy-customer-profile: setup page server')
  registerCustomerProfileTool(ctx, { dataDirectory: options.dataDirectory })
  registerCustomerProfileSkill(ctx)
}
