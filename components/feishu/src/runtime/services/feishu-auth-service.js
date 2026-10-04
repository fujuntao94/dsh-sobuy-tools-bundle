/**
 * 插件内部共享的飞书认证 Service。
 *
 * Tool 不再直接读取 token 文件或 App Secret：统一通过 ctx.feishuAuth
 * 获取当前 OAuth 身份与短期应用 token，避免后续业务工具重复认证逻辑。
 */
import { createFeishuOAuthSdkClient, createFeishuSdkClient } from '../../domains/auth/feishu-sdk.js'
import { getValidUserToken, refreshStoredUserToken } from '../../domains/auth/user-token.js'
import { configPath, defaultDataDirectory, readJson } from '../../domains/auth/token-store.js'

export function createFeishuAuthService({
  dataDirectory = defaultDataDirectory(),
  // 仅供单测注入；生产环境保持默认领域实现。
  getValidUserTokenImpl = getValidUserToken,
  refreshStoredUserTokenImpl = refreshStoredUserToken,
} = {}) {
  // 同一个插件会话中多个 Tool 常常连续读取同一位授权用户。
  // 缓存到 access token 的提前刷新时间，既避免重复读 token，也不会拿临近过期的身份继续发请求。
  let cachedActiveUser
  let pendingActiveUser
  let applicationClient
  let oauthClient
  let clientKey

  function waitForActiveUser(promise, signal) {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(new Error('飞书请求已取消'))
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('飞书请求已取消'))
      signal.addEventListener('abort', abort, { once: true })
      promise.then(
        value => { signal.removeEventListener('abort', abort); resolve(value) },
        error => { signal.removeEventListener('abort', abort); reject(error) },
      )
    })
  }

  async function credentials() {
    const value = await readJson(configPath(dataDirectory))
    if (!value?.appId || !value?.appSecret) throw new Error('请先在飞书设置页填写 App ID 和 App Secret。')
    return value
  }

  async function clientCredentials() {
    const value = await credentials()
    const key = `${value.appId}:${value.appSecret}`
    if (key !== clientKey) {
      applicationClient = undefined
      oauthClient = undefined
      clientKey = key
    }
    return value
  }

  async function getApplicationClient({ signal } = {}) {
    const value = await clientCredentials()
    if (signal) return createFeishuSdkClient(value, { signal })
    if (!applicationClient) applicationClient = createFeishuSdkClient(value)
    return applicationClient
  }

  async function getOAuthClient({ signal } = {}) {
    const value = await clientCredentials()
    if (signal) return createFeishuOAuthSdkClient(value, { signal })
    if (!oauthClient) oauthClient = createFeishuOAuthSdkClient(value)
    return oauthClient
  }

  async function loadActiveUser(signal) {
    const oauth = await getOAuthClient({ signal })
    const active = await getValidUserTokenImpl({ dataDirectory, signal, oauthClient: oauth })
    const cacheUntil = Number(active.token.expiresAt || 0) - 5 * 60 * 1000
    cachedActiveUser = { active, cacheUntil }
    return active
  }

  async function loadCurrentUser(signal) {
    const active = await getActiveUser(signal)
    const openId = active.user?.openId || active.token.user?.openId
    if (!openId || !/^ou_[A-Za-z0-9]+$/.test(openId)) {
      throw new Error('当前飞书授权未包含有效 open_id，请重新登录后重试。')
    }
    return { active, openId }
  }

  async function getActiveUser(signal) {
    if (cachedActiveUser?.cacheUntil > Date.now()) return cachedActiveUser.active
    // 所有 Tool 共用同一个 Promise，refresh_token 只会刷新一次。
    if (!pendingActiveUser) {
      // 刷新是共享操作，不能绑定首个 Tool 的取消信号；每个调用方只取消自己的等待。
      pendingActiveUser = loadActiveUser().finally(() => { pendingActiveUser = undefined })
    }
    return waitForActiveUser(pendingActiveUser, signal)
  }

  return {
    async getActiveUser({ signal } = {}) {
      return getActiveUser(signal)
    },

    async getCurrentOpenId({ signal } = {}) {
      return loadCurrentUser(signal)
    },

    // 登录、刷新或退出后由登录 Tool 调用，避免账户切换时使用旧身份缓存。
    clearCurrentUserCache() {
      cachedActiveUser = undefined
      pendingActiveUser = undefined
    },

    async refreshCurrentUser({ signal } = {}) {
      const oauth = await getOAuthClient({ signal })
      const refreshed = await refreshStoredUserTokenImpl({ dataDirectory, signal, oauthClient: oauth })
      cachedActiveUser = { active: { token: refreshed.token, refreshed: true, user: refreshed.user }, cacheUntil: refreshed.token.expiresAt - 5 * 60 * 1000 }
      return refreshed
    },

    async getSdkClient({ signal } = {}) {
      return getApplicationClient({ signal })
    },

    async getOAuthSdkClient({ signal } = {}) {
      return getOAuthClient({ signal })
    },
  }
}

/** 将 Service 生命周期绑定到当前 Cordis 插件 fiber。 */
export function provideFeishuAuthService(ctx, config = {}) {
  const dataDirectory = config.dataDirectory || defaultDataDirectory()
  const service = createFeishuAuthService({ dataDirectory })
  ctx.provide('feishuAuth', service)
  return service
}
