/**
 * 飞书 HTTP 最小适配层。
 *
 * 只保留本插件实际使用的 OAuth、通讯录和假期余额接口，不再引入完整 Node SDK。
 * 这样可去掉 SDK 间接依赖的 protobufjs，避免 Desktop 的 pnpm 安全策略拦截无用的 postinstall 脚本。
 */
import axios from 'axios'
import { toFeishuApiError } from './feishu-error.js'

const OPEN_API_ORIGIN = 'https://open.feishu.cn'
const OAUTH_ORIGIN = 'https://accounts.feishu.cn'
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000

function requireCredentials({ appId, appSecret }) {
  if (!appId || !appSecret) throw new Error('请先在飞书设置页填写 App ID 和 App Secret。')
}

function responseData(response) {
  return response?.data ?? response
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value || ''))
}

function oauthTokenShape(data) {
  return {
    accessToken: data?.access_token,
    tokenType: data?.token_type,
    expiresIn: data?.expires_in,
    refreshToken: data?.refresh_token,
    refreshTokenExpiresIn: data?.refresh_token_expires_in,
    scope: data?.scope,
  }
}

/** 为 OAuth 用户信息请求生成显式用户令牌选项，保持上层调用接口不变。 */
export function withUserAccessToken(accessToken) {
  return { userAccessToken: accessToken }
}

function createClient({ appId, appSecret }, { signal, oauthOnly = false } = {}) {
  requireCredentials({ appId, appSecret })
  // signal 仅绑定本次临时 client，取消一个 Tool 不会影响共享 client。
  const httpInstance = axios.create({ baseURL: OPEN_API_ORIGIN, signal, timeout: 20_000 })
  let tenantToken
  let tenantTokenExpiresAt = 0
  let pendingTenantToken

  async function getTenantAccessToken() {
    if (tenantToken && tenantTokenExpiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return tenantToken
    if (!pendingTenantToken) {
      pendingTenantToken = httpInstance.post('/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: appId,
        app_secret: appSecret,
      }).then(responseData).then(data => {
        if (data?.code !== 0 || !data?.tenant_access_token) throw new Error(data?.msg || '获取飞书应用访问令牌失败')
        tenantToken = data.tenant_access_token
        tenantTokenExpiresAt = Date.now() + Number(data.expire || 0) * 1000
        return tenantToken
      }).finally(() => { pendingTenantToken = undefined })
    }
    return pendingTenantToken
  }

  async function requestWithTenant(config) {
    const token = await getTenantAccessToken()
    const response = await httpInstance.request({
      ...config,
      headers: { ...config.headers, Authorization: `Bearer ${token}` },
    })
    return responseData(response)
  }

  async function request(config) {
    const response = await httpInstance.request(config)
    return responseData(response)
  }

  async function exchangeUserToken(payload) {
    const response = await axios.post(`${OAUTH_ORIGIN}/oauth/v3/token`, {
      client_id: appId,
      client_secret: appSecret,
      ...payload,
    }, { signal, timeout: 20_000 })
    const data = responseData(response)
    if (data?.error || !data?.access_token) {
      const error = new Error(data?.error_description || data?.msg || data?.error || '飞书 OAuth 换取令牌失败')
      error.code = data?.code
      throw error
    }
    return oauthTokenShape(data)
  }

  return {
    httpInstance,
    request,
    accessToken: {
      retrieveByAuthorizationCode: ({ code, redirectUri }) => exchangeUserToken({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      }),
      refresh: ({ refreshToken }) => exchangeUserToken({
        grant_type: 'refresh_token', refresh_token: refreshToken,
      }),
    },
    authen: {
      v1: {
        userInfo: {
          get: async (_payload, options = {}) => {
            const response = await httpInstance.get('/open-apis/authen/v1/user_info', {
              headers: { Authorization: `Bearer ${options.userAccessToken}` },
            })
            return responseData(response)
          },
        },
      },
    },
    // OAuth client 只使用 OAuth 和 user-info 能力，不触发 tenant token 请求。
    ...(oauthOnly ? {} : {
      contact: {
        v3: {
          user: {
            get: ({ path, params }) => requestWithTenant({
              url: `/open-apis/contact/v3/users/${encodePathSegment(path?.user_id)}`,
              method: 'GET', params,
            }),
          },
          department: {
            get: ({ path, params }) => requestWithTenant({
              url: `/open-apis/contact/v3/departments/${encodePathSegment(path?.department_id)}`,
              method: 'GET', params,
            }),
          },
        },
      },
      corehr: {
        v1: {
          leave: {
            leaveBalances: ({ params }) => requestWithTenant({
              url: '/open-apis/corehr/v1/leaves/leave_balances', method: 'GET', params,
            }),
          },
        },
      },
    }),
  }
}

/** 应用身份接口使用；tenant_access_token 在实例中缓存并自动续期。 */
export function createFeishuSdkClient(credentials, options) {
  return createClient(credentials, options)
}

/** OAuth 专用 Client 不请求 tenant_access_token。 */
export function createFeishuOAuthSdkClient(credentials, options) {
  return createClient(credentials, { ...options, oauthOnly: true })
}

/** 将 HTTP/飞书业务错误统一为原始飞书 msg，避免包装后丢失排障信息。 */
export async function sdkData(work, fallbackMessage, { retry = true } = {}) {
  try {
    let response
    let attempt = 0
    while (true) {
      try {
        response = await work()
        break
      } catch (error) {
        const safe = toFeishuApiError(error, fallbackMessage)
        if (!retry || attempt >= 2 || !['network', 'rate_limited'].includes(safe.kind)) throw safe
        await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt++ + Math.floor(Math.random() * 80)))
      }
    }
    if (response?.error || (response?.code !== undefined && response.code !== 0 && response.code !== '0')) {
      throw new Error(response.error_description || response.msg || response.error || fallbackMessage)
    }
    return response?.data ?? response ?? {}
  } catch (error) {
    throw toFeishuApiError(error, fallbackMessage)
  }
}
