/**
 * 数据库凭据的独立私有存储层。
 *
 * 数据库配置不复用飞书目录或 OAuth 登录态，避免两个组件互相覆盖凭据。
 */
import { join } from 'node:path'
import { readOptionalJson, writePrivateJson } from 'sobuy-plugin-core/storage'
import { componentDataDirectory } from 'sobuy-plugin-core/dsh-paths'

export function defaultDataDirectory() {
  return componentDataDirectory('database-tools')
}

export function configPath(dataDirectory = defaultDataDirectory()) {
  return join(dataDirectory, 'config.json')
}

export async function readConfig(dataDirectory = defaultDataDirectory()) {
  const file = configPath(dataDirectory)
  try {
    return await readOptionalJson(file)
  } catch (error) {
    throw new Error(`无法读取数据库配置 ${file}：${error.message}`)
  }
}

/** 以 0700 目录、0600 文件权限原子保存数据库配置。 */
export async function writePrivateConfig(value, dataDirectory = defaultDataDirectory()) {
  await writePrivateJson(configPath(dataDirectory), value)
}
