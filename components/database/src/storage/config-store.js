/**
 * 数据库凭据的独立私有存储层。
 *
 * 数据库配置不复用飞书目录或 OAuth 登录态，避免两个组件互相覆盖凭据。
 */
import { join } from 'node:path'
import { readOptionalJson, writePrivateJson } from 'sobuy-plugin-core/storage'
import { componentDataDirectory } from 'sobuy-plugin-core/dsh-paths'
import { upgradeLegacyAttributionAllowlist } from '../domains/soldout-attribution.js'

export function defaultDataDirectory() {
  return componentDataDirectory('database-tools')
}

export function configPath(dataDirectory = defaultDataDirectory()) {
  return join(dataDirectory, 'config.json')
}

export async function readConfig(dataDirectory = defaultDataDirectory()) {
  const file = configPath(dataDirectory)
  try {
    // 兼容旧版本已启用的缺货归因白名单；本次读取不写盘，用户下次保存设置时会持久化。
    return upgradeLegacyAttributionAllowlist(await readOptionalJson(file))
  } catch (error) {
    throw new Error(`无法读取数据库配置 ${file}：${error.message}`)
  }
}

/** 以 0700 目录、0600 文件权限原子保存数据库配置。 */
export async function writePrivateConfig(value, dataDirectory = defaultDataDirectory()) {
  await writePrivateJson(configPath(dataDirectory), value)
}
