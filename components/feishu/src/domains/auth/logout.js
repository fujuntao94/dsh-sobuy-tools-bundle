/**
 * 飞书退出登录处理流程。
 *
 * 这里负责远端撤销和本机清理；工具层只需调用 logout()，不需要了解 token 文件结构。
 */
import { revokeOAuthToken } from './oauth.js'
import {
  authorizationStatusPath,
  configPath,
  defaultDataDirectory,
  readJson,
  removeToken,
  tokenPath,
  writePrivateJson,
} from './token-store.js'

function hasApplicationCredentials(credentials) {
  return Boolean(credentials?.appId && credentials?.appSecret)
}

/**
 * 撤销飞书的登录令牌，再清理本机登录态。
 * 本地没有 token 时仍可安全调用，用于处理曾经登录失败留下的状态文件。
 */
export async function logout({ dataDirectory = defaultDataDirectory(), signal } = {}) {
  const token = await readJson(tokenPath(dataDirectory))
  if (!token?.accessToken) {
    await removeToken(dataDirectory)
    await writePrivateJson(authorizationStatusPath(dataDirectory), { state: 'idle', updatedAt: Date.now() })
    return
  }

  const credentials = await readJson(configPath(dataDirectory))
  if (!hasApplicationCredentials(credentials)) {
    throw new Error('无法撤销飞书登录：本机缺少 App ID 或 App Secret。')
  }

  // 远端撤销成功后才删除本机 token，避免用户误以为已经退出。
  await revokeOAuthToken({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    token: token.refreshToken || token.accessToken,
    tokenTypeHint: token.refreshToken ? 'refresh_token' : 'access_token',
    signal,
  })
  await removeToken(dataDirectory)
  await writePrivateJson(authorizationStatusPath(dataDirectory), { state: 'idle', updatedAt: Date.now() })
}
