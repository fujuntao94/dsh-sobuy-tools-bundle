/**
 * 浏览器设置页的授权编排流程。
 *
 * oauth.js 只提供通用的 HTTP 回调与飞书 OAuth 请求；本文件负责把这些能力组合成
 * “保存凭据 → 跳转飞书 → 保存授权结果”的完整设置页流程。
 */
import { randomUUID } from 'node:crypto'
import {
  createAuthorizationFlow,
  exchangeAuthorizationCode,
  getUserInfo,
  normalizeToken,
  startSetupPageServer,
} from './oauth.js'
import { createFeishuOAuthSdkClient } from './feishu-sdk.js'
import {
  authorizationStatusPath,
  configPath,
  readJson,
  removeToken,
  tokenPath,
  withCredentialLock,
  writePrivateJson,
} from './token-store.js'

function redactAuthorizationError(error) {
  const message = error instanceof Error && error.message ? error.message : '未知错误'
  // 错误会显示到浏览器页面，因此必须移除可能出现在飞书响应中的敏感字段值。
  return message
    .replace(/(app_secret|client_secret|access_token|refresh_token|code)=?[^\s,;&]*/gi, '$1=[已隐藏]')
    .slice(0, 240)
}

function assertAccessToken(token, rawToken) {
  if (token.accessToken) return
  const keys = rawToken && typeof rawToken === 'object'
    ? Object.keys(rawToken).sort().join('、') || '无'
    : '无'
  throw new Error(`飞书令牌响应缺少用户 access token（返回字段：${keys}）。`)
}

/**
 * 用刚取得的授权码换取 token，并安全保存到本机。
 * 浏览器设置页回调和工具中的 login action 都复用此函数，避免两套保存逻辑不一致。
 */
export async function saveAuthorizationResult({ credentials, redirectUri, code, dataDirectory, signal, authorizationAttemptId }) {
  const client = createFeishuOAuthSdkClient(credentials, { signal })
  const rawToken = await exchangeAuthorizationCode({ ...credentials, redirectUri, code, client, signal })
  const user = await getUserInfo({
    accessToken: rawToken.access_token ?? rawToken.user_access_token,
    client,
  })
  const token = normalizeToken(rawToken, user)
  assertAccessToken(token, rawToken)
  await withCredentialLock(dataDirectory, async () => {
    const currentCredentials = await readJson(configPath(dataDirectory))
    if (currentCredentials?.appId !== credentials.appId || currentCredentials?.appSecret !== credentials.appSecret) {
      throw new Error('飞书应用配置已变化，已丢弃旧的授权结果，请重新授权。')
    }
    if (authorizationAttemptId) {
      const currentAuthorization = await readJson(authorizationStatusPath(dataDirectory))
      if (currentAuthorization?.attemptId !== authorizationAttemptId) {
        throw new Error('飞书授权流程已更新，已丢弃旧的授权结果，请完成最新一次授权。')
      }
    }
    await writePrivateJson(tokenPath(dataDirectory), token)
    await writePrivateJson(authorizationStatusPath(dataDirectory), {
      state: 'success',
      ...(authorizationAttemptId ? { attemptId: authorizationAttemptId } : {}),
      updatedAt: Date.now(),
    })
  })
  return token
}

/** 创建仅监听本机回环地址的浏览器设置页服务。 */
export function createSetupPageServer(ctx, options, redirectUri) {
  return startSetupPageServer({
    host: options.setupHost,
    port: options.setupPort,
    setupPath: options.setupPath,
    statusPath: options.statusPath,
    onError: error => ctx.logger?.warn('飞书设置页请求失败：%s', error.message),

    async getStatus() {
      const [credentials, token, authorization] = await Promise.all([
        readJson(configPath(options.dataDirectory)),
        readJson(tokenPath(options.dataDirectory)),
        readJson(authorizationStatusPath(options.dataDirectory)),
      ])
      return {
        appId: credentials?.appId || '',
        appSecretConfigured: Boolean(credentials?.appSecret),
        loggedIn: Boolean(token?.accessToken),
        user: token?.user?.name ? { name: token.user.name } : undefined,
        authorizationState: token?.accessToken ? 'success' : authorization?.state || 'idle',
        authorizationError: token?.accessToken || authorization?.state !== 'error' ? undefined : authorization.message,
      }
    },

    async resolveCredentials({ appId, appSecret }) {
      const previous = await readJson(configPath(options.dataDirectory))
      // Secret 已保存时，浏览器不需要也不能读取它；留空表示继续使用旧值。
      return {
        appId: appId || previous?.appId,
        appSecret: appSecret || previous?.appSecret,
        previousAppId: previous?.appId,
      }
    },

    async beginAuthorization(credentials) {
      const { previousAppId, ...nextCredentials } = credentials
      const authorizationAttemptId = randomUUID()
      // OAuth token 绑定应用；切换 App ID 后不能继续复用旧应用签发的登录态。
      if (previousAppId && previousAppId !== nextCredentials.appId) {
        ctx.feishuAuth?.clearCurrentUserCache()
      }
      await withCredentialLock(options.dataDirectory, async () => {
        if (previousAppId && previousAppId !== nextCredentials.appId) {
          await removeToken(options.dataDirectory)
        }
        await writePrivateJson(configPath(options.dataDirectory), { ...nextCredentials, redirectUri })
        await writePrivateJson(authorizationStatusPath(options.dataDirectory), {
          state: 'pending', attemptId: authorizationAttemptId, updatedAt: Date.now(),
        })
      })

      const { authorizationUrl, ready, completed } = createAuthorizationFlow({
        appId: nextCredentials.appId,
        redirectUri,
        scope: options.oauthScope,
        host: options.callbackHost,
        port: options.callbackPort,
        path: options.callbackPath,
        timeoutMs: options.authorizationTimeoutMs,
        onAuthorizationCode: async code => {
          const token = await saveAuthorizationResult({
            credentials: nextCredentials,
            redirectUri,
            code,
            dataDirectory: options.dataDirectory,
            authorizationAttemptId,
          })
          ctx.feishuAuth?.clearCurrentUserCache()
          return token
        },
      })

      // 浏览器回调在后台执行；失败信息只以脱敏文本保存，供设置页下次读取。
      void completed.catch(async error => {
        const message = redactAuthorizationError(error)
        await withCredentialLock(options.dataDirectory, async () => {
          const currentAuthorization = await readJson(authorizationStatusPath(options.dataDirectory))
          if (currentAuthorization?.attemptId !== authorizationAttemptId) return
          await writePrivateJson(authorizationStatusPath(options.dataDirectory), {
            state: 'error', attemptId: authorizationAttemptId, message, updatedAt: Date.now(),
          })
        }).catch(writeError => {
          ctx.logger?.warn('无法保存飞书授权错误状态：%s', writeError.message)
        })
        ctx.logger?.warn('飞书网页登录未完成：%s', message)
      })

      await ready
      return authorizationUrl
    },
  })
}
