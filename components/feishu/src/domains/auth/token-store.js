/**
 * 私有存储层：唯一允许读写本地凭据的模块。
 * 其他模块只调用这里的函数，避免散落的文件权限和原子写入逻辑。
 */
import { unlink } from 'node:fs/promises'
// 仅使用路径工具组合本地文件名，避免自行拼接平台相关分隔符。
import { dirname, join } from 'node:path'
// 临时文件名使用 UUID，避免并发写入时相互覆盖。
import { isVaultEnabled, readVaultSecret, removeVaultSecret, writeVaultSecret } from './credential-vault.js'
import { readOptionalJson, writePrivateJson as writePrivateJsonFile } from 'sobuy-plugin-core/storage'
import { componentDataDirectory } from 'sobuy-plugin-core/dsh-paths'

// 同一数据目录的身份切换、退出、授权保存与刷新提交必须串行，防止旧网络请求覆盖新登录态。
const credentialLocks = new Map()

export async function withCredentialLock(dataDirectory, work) {
  const previous = credentialLocks.get(dataDirectory) || Promise.resolve()
  let release
  const current = new Promise(resolve => { release = resolve })
  credentialLocks.set(dataDirectory, current)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (credentialLocks.get(dataDirectory) === current) credentialLocks.delete(dataDirectory)
  }
}

/** 固定使用既有数据目录，确保品牌重命名不影响已有登录态。 */
export function defaultDataDirectory() {
  return componentDataDirectory('feishu-login')
}

/** 返回用户令牌的固定保存路径。 */
export function tokenPath(dataDirectory = defaultDataDirectory()) {
  return join(dataDirectory, 'token.json')
}

/** 返回包含 App ID、App Secret、redirectUri 的本地配置路径。 */
export function configPath(dataDirectory = defaultDataDirectory()) {
  return join(dataDirectory, 'config.json')
}

/** 返回最近一次网页登录的脱敏结果，供 Desktop 设置页提示授权进度或失败原因。 */
export function authorizationStatusPath(dataDirectory = defaultDataDirectory()) {
  return join(dataDirectory, 'authorization-status.json')
}

function vaultNamespace(file) {
  return dirname(file)
}

/**
 * 读取 JSON 文件；文件不存在代表用户尚未配置或登录，不视为系统异常。
 * 其余 I/O、权限或 JSON 解析错误必须抛出，以免把损坏凭据误判为未登录。
 */
export async function readJson(file) {
  try {
    const value = await readOptionalJson(file)
    if (value === undefined) return undefined
    if (!isVaultEnabled()) return value
    if (file === configPath(dirname(file))) {
      return { ...value, appSecret: await readVaultSecret('app-secret', vaultNamespace(file)) || value.appSecret }
    }
    if (file === tokenPath(dirname(file))) {
      return {
        ...value,
        accessToken: await readVaultSecret('access-token', vaultNamespace(file)) || value.accessToken,
        refreshToken: await readVaultSecret('refresh-token', vaultNamespace(file)) || value.refreshToken,
      }
    }
    return value
  } catch (error) {
    throw new Error(`无法读取 ${file}：${error.message}`)
  }
}

/**
 * 以私有权限原子写入 JSON。
 * 先写同目录临时文件，再 rename 覆盖目标：进程崩溃时旧 token 仍完整，不会留下截断 JSON。
 */
export async function writePrivateJson(file, value) {
  // Vault 映射仍属于飞书领域；共享层只处理文件权限与原子落盘。
  let storedValue = value
  if (isVaultEnabled() && file === configPath(dirname(file))) {
    await writeVaultSecret('app-secret', value.appSecret, vaultNamespace(file))
    const { appSecret: _appSecret, ...metadata } = value
    storedValue = metadata
  }
  if (isVaultEnabled() && file === tokenPath(dirname(file))) {
    await writeVaultSecret('access-token', value.accessToken, vaultNamespace(file))
    await writeVaultSecret('refresh-token', value.refreshToken, vaultNamespace(file))
    const { accessToken: _accessToken, refreshToken: _refreshToken, ...metadata } = value
    storedValue = metadata
  }
  await writePrivateJsonFile(file, storedValue)
}

/** 删除本机用户令牌，实现插件侧退出登录；不存在时保持幂等。 */
export async function removeToken(dataDirectory) {
  await unlink(tokenPath(dataDirectory)).catch(error => {
    if (error?.code !== 'ENOENT') throw error
  })
  await Promise.all([removeVaultSecret('access-token', dataDirectory), removeVaultSecret('refresh-token', dataDirectory)])
}
