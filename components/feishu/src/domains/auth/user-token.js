/**
 * 用户身份 token 的读取、手动刷新与自动刷新。
 * 业务工具只调用 getValidUserToken，不需要接触 App Secret 或 token 文件。
 */
import { getUserInfo, normalizeToken, refreshAccessToken } from './oauth.js'
import { createFeishuOAuthSdkClient } from './feishu-sdk.js'
import { configPath, defaultDataDirectory, readJson, tokenPath, withCredentialLock, writePrivateJson } from './token-store.js'

// 提前五分钟刷新，避免请求刚发出时 token 恰好过期。
const REFRESH_BEFORE_MS = 5 * 60 * 1000

function hasRefreshCredentials(credentials) {
  return Boolean(credentials?.appId && credentials?.appSecret)
}

function sameRefreshSource(expectedCredentials, expectedToken, currentCredentials, currentToken) {
  return currentCredentials?.appId === expectedCredentials.appId
    && currentCredentials?.appSecret === expectedCredentials.appSecret
    && currentToken?.refreshToken === expectedToken.refreshToken
}

/**
 * 使用本机 refresh token 换取并保存新的用户 token。
 * `feishu_login` 的手动刷新和业务工具的自动刷新共用这一个函数。
 */
export async function refreshStoredUserToken({ dataDirectory = defaultDataDirectory(), signal, oauthClient } = {}) {
  const [credentials, savedToken] = await Promise.all([
    readJson(configPath(dataDirectory)),
    readJson(tokenPath(dataDirectory)),
  ])
  if (!hasRefreshCredentials(credentials)) {
    throw new Error('请先在飞书设置页填写 App ID 和 App Secret。')
  }
  if (!savedToken?.refreshToken) {
    throw new Error('飞书登录已过期且无法刷新，请重新授权。')
  }

  // 飞书可能轮换 refresh_token；normalizeToken 会保留本次响应的新 token。
  const client = oauthClient || createFeishuOAuthSdkClient(credentials, { signal })
  const rawToken = await refreshAccessToken({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    refreshToken: savedToken.refreshToken,
    client,
    signal,
  })
  const user = await getUserInfo({
    accessToken: rawToken.access_token ?? rawToken.user_access_token,
    client,
  })
  const token = normalizeToken(rawToken, user)
  if (!token.accessToken) throw new Error('飞书刷新 token 失败，请重新授权。')
  // 网络请求期间用户可能已退出、重新授权或切换应用；旧刷新结果绝不能覆盖新的本机身份。
  await withCredentialLock(dataDirectory, async () => {
    const [currentCredentials, currentToken] = await Promise.all([
      readJson(configPath(dataDirectory)),
      readJson(tokenPath(dataDirectory)),
    ])
    if (!sameRefreshSource(credentials, savedToken, currentCredentials, currentToken)) {
      throw new Error('飞书登录状态已变化，已丢弃旧的刷新结果，请重试当前操作。')
    }
    await writePrivateJson(tokenPath(dataDirectory), token)
  })
  // user 不写入 token 文件的完整资料只留在本次内存中，供调用方避免重复请求。
  return { token, user }
}

/**
 * 取得可直接调用飞书 API 的用户 token。
 * token 未临近过期时直接复用；需要刷新时会原子覆盖本机 token 文件。
 */
export async function getValidUserToken({ dataDirectory = defaultDataDirectory(), signal, oauthClient } = {}) {
  const [credentials, savedToken] = await Promise.all([
    readJson(configPath(dataDirectory)),
    readJson(tokenPath(dataDirectory)),
  ])

  if (!hasRefreshCredentials(credentials)) {
    throw new Error('请先在飞书设置页填写 App ID 和 App Secret。')
  }
  if (!savedToken?.accessToken) {
    throw new Error('尚未完成飞书授权，请先在设置页完成授权。')
  }

  const expiresSoon = !savedToken.expiresAt || savedToken.expiresAt - Date.now() <= REFRESH_BEFORE_MS
  if (!expiresSoon) return { token: savedToken, refreshed: false }
  const refreshed = await refreshStoredUserToken({ dataDirectory, signal, oauthClient })
  // 刷新函数已经查询过用户资料；直接复用本次保存的数据，避免业务工具再发一次请求。
  return { token: refreshed.token, refreshed: true, user: refreshed.user }
}
