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
  withCredentialLock,
  writePrivateJson,
} from './token-store.js'

function hasApplicationCredentials(credentials) {
  return Boolean(credentials?.appId && credentials?.appSecret)
}

function isSameStoredToken(expected, current) {
  return current?.accessToken === expected?.accessToken
    && current?.refreshToken === expected?.refreshToken
}

/**
 * 撤销飞书的登录令牌，再清理本机登录态。
 * 本地没有 token 时仍可安全调用，用于处理曾经登录失败留下的状态文件。
 */
export async function logout({ dataDirectory = defaultDataDirectory(), signal, revokeOAuthTokenImpl = revokeOAuthToken } = {}) {
  const token = await readJson(tokenPath(dataDirectory))
  if (!token?.accessToken) {
    await withCredentialLock(dataDirectory, async () => {
      // 读取后可能已有新的登录完成；无 token 的旧退出请求不能删除新登录态。
      if ((await readJson(tokenPath(dataDirectory)))?.accessToken) return
      await removeToken(dataDirectory)
      await writePrivateJson(authorizationStatusPath(dataDirectory), { state: 'idle', updatedAt: Date.now() })
    })
    return
  }

  const credentials = await readJson(configPath(dataDirectory))
  if (!hasApplicationCredentials(credentials)) {
    throw new Error('无法撤销飞书登录：本机缺少 App ID 或 App Secret。')
  }

  // 远端撤销成功后才删除本机 token，避免用户误以为已经退出。
  await revokeOAuthTokenImpl({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    token: token.refreshToken || token.accessToken,
    tokenTypeHint: token.refreshToken ? 'refresh_token' : 'access_token',
    signal,
  })
  await withCredentialLock(dataDirectory, async () => {
    // 远端撤销期间可能已重新登录；只清理本次实际撤销的那份 token。
    const currentToken = await readJson(tokenPath(dataDirectory))
    if (!isSameStoredToken(token, currentToken)) return
    await removeToken(dataDirectory)
    await writePrivateJson(authorizationStatusPath(dataDirectory), { state: 'idle', updatedAt: Date.now() })
  })
}
