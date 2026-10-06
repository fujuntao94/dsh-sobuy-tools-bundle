/**
 * OAuth 协议层：只处理飞书 OAuth 协议、浏览器跳转和本机 HTTP 回调。
 * 工具层不需要知道 HTTP 实现，只调用这里导出的函数。
 */
// 模板在插件加载时读取一次；后续每个 HTTP 请求只做占位符替换。
import { readFileSync } from 'node:fs'
// 加密安全随机数用于 OAuth state，不能用时间戳或 Math.random() 替代。
import { randomBytes } from 'node:crypto'
// 使用各平台默认的 URL 打开程序将授权页交给系统浏览器。
import { spawn } from 'node:child_process'
import {
  createFeishuOAuthSdkClient,
  sdkData,
  withUserAccessToken,
} from './feishu-sdk.js'
import { toFeishuApiError } from './feishu-error.js'
import { startOAuthCallbackServer } from './oauth-callback-server.js'
import { requireObject, requireString } from '../response-validation.js'
import {
  createLocalSetupServer,
  escapeHtml,
  localOrigin,
  renderTemplate,
} from 'sobuy-plugin-core/http'

export { localOrigin }

// 仅浏览器授权地址与 SDK 尚未语义化封装的撤销地址保留为 URL 常量。
export const AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
export const REVOKE_URL = 'https://accounts.feishu.cn/oauth/v1/revoke'

const CALLBACK_TEMPLATE = readFileSync(new URL('../../ui/pages/callback.html', import.meta.url), 'utf8')
const SETUP_TEMPLATE = readFileSync(new URL('../../ui/pages/setup.html', import.meta.url), 'utf8')

export function createState() {
  // 32 字节随机值编码为 URL 安全字符串，足以防止猜测或回调串号。
  return randomBytes(32).toString('base64url')
}

/** 根据本次登录参数构造飞书授权页 URL。 */
export function buildAuthorizeUrl({ appId, redirectUri, state, scope = 'offline_access contact:user.base:readonly' }) {
  const url = new URL(AUTHORIZE_URL)
  // OAuth v2 的 token 端点使用 client_id；授权端也必须使用相同客户端标识与授权码响应类型。
  url.searchParams.set('client_id', appId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', scope)
  url.searchParams.set('state', state)
  return url.toString()
}

/** 创建一次 OAuth 回调流程；设置页跳转和 Tool 直接打开浏览器共用相同的 state 校验与完成逻辑。 */
export function createAuthorizationFlow({ appId, redirectUri, scope, host, port, path, timeoutMs, signal, onAuthorizationCode }) {
  const state = createState()
  const callback = waitForCallback({ host, port, path, expectedState: state, timeoutMs, signal, onAuthorizationCode })
  return {
    authorizationUrl: buildAuthorizeUrl({ appId, redirectUri, state, scope }),
    // 调用方必须先等待 ready，再跳转授权页；端口占用时不能让用户完成一场无法回调的授权。
    ready: callback.ready,
    completed: callback.completed,
  }
}

/**
 * 在 macOS、Windows、Linux 上调用默认浏览器。
 * 子进程脱离插件生命周期，不等待浏览器退出，也不读取任何浏览器输出。
 */
export function openInBrowser(url) {
  const command = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' })
  child.unref()
}

/** 返回授权结果页面；不包含授权码、令牌或应用凭据。 */
export function callbackHtml(title, detail, { tone = 'error', autoClose = false } = {}) {
  const success = tone === 'success'
  const icon = success
    ? '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M14 24.5 21 31l14-15"/></svg>'
    : '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 14v12m0 8h.01"/></svg>'
  return renderTemplate(CALLBACK_TEMPLATE, {
    title: escapeHtml(title),
    detail: escapeHtml(detail),
    tone: success ? 'success' : 'error',
    icon,
    autoCloseSeconds: autoClose ? '6' : '0',
  })
}

/** 在回调成功页返回前完成授权码后续处理；未提供处理器时兼容返回原始授权码。 */
export async function completeAuthorizationCode(code, onAuthorizationCode) {
  return onAuthorizationCode ? onAuthorizationCode(code) : code
}

/** 浏览器设置页只接收模板需要的安全占位符，不回显已保存的密钥。 */
export function setupHtml({ setupPath, setupToken, statusPath, message = '' }) {
  return renderTemplate(SETUP_TEMPLATE, {
    setupPath: escapeHtml(setupPath), setupToken: escapeHtml(setupToken),
    message: escapeHtml(message), noticeHidden: message ? '' : 'hidden',
    statusPath: escapeHtml(statusPath),
  })
}

/**
 * 启动浏览器设置页。这个常驻服务只监听本机回环地址。
 */
export function startSetupPageServer({ host, port, setupPath, statusPath, getStatus, resolveCredentials, beginAuthorization, onError }) {
  return createLocalSetupServer({
    host,
    port,
    setupPath,
    statusPath,
    bodyLimitBytes: 8192,
    renderPage: ({ setupToken, message }) => setupHtml({ setupPath, setupToken, statusPath, message }),
    getStatus,
    statusError: '无法读取飞书登录状态',
    onError,
    submit: async form => {
      try {
        const credentials = await resolveCredentials({
          appId: form.get('app_id')?.trim(), appSecret: form.get('app_secret')?.trim(),
        })
        if (!credentials.appId || !credentials.appSecret) {
          return { message: '请填写有效的 App ID 和 App Secret。' }
        }
        const authorizationUrl = await beginAuthorization(credentials)
        // 凭据只在本机 POST 请求体中出现；浏览器随后直接跳转飞书官方域名。
        return { redirect: authorizationUrl }
      } catch {
        return { message: '无法保存配置或启动飞书授权，请检查应用信息后重试。' }
      }
    },
  })
}

/**
 * 启动一次性本地回调服务并等待飞书重定向。
 * Promise 只有成功拿到授权码、回调异常、超时或用户取消四种结束路径；任一路径均会关闭服务。
 */
export function waitForCallback({ host, port, path, expectedState, timeoutMs, signal, onAuthorizationCode }) {
  return startOAuthCallbackServer({
    host,
    port,
    path,
    expectedState,
    timeoutMs,
    signal,
    onAuthorizationCode: code => completeAuthorizationCode(code, onAuthorizationCode),
    renderCallbackPage: callbackHtml,
  })
}

function legacyTokenShape(token) {
  return {
    access_token: token.accessToken,
    token_type: token.tokenType,
    expires_in: token.expiresIn,
    refresh_token: token.refreshToken,
    refresh_expires_in: token.refreshTokenExpiresIn,
    scope: token.scope,
  }
}

export async function exchangeAuthorizationCode({ appId, appSecret, redirectUri, code, client }) {
  // authorization_code 只能由刚验证过 state 的 callback 提供，绝不记录到日志。
  const oauthClient = client || createFeishuOAuthSdkClient({ appId, appSecret })
  try {
    const token = await oauthClient.accessToken.retrieveByAuthorizationCode({ code, redirectUri })
    requireString(token?.accessToken, '授权码换取 token')
    return legacyTokenShape(token)
  } catch (error) {
    throw toFeishuApiError(error, '飞书授权码换取 token 失败')
  }
}

export async function refreshAccessToken({ appId, appSecret, refreshToken, client }) {
  // 飞书可能轮换 refresh_token，调用方必须保存本次响应中的新 token。
  const oauthClient = client || createFeishuOAuthSdkClient({ appId, appSecret })
  try {
    const token = await oauthClient.accessToken.refresh({ refreshToken })
    requireString(token?.accessToken, '刷新 token')
    return legacyTokenShape(token)
  } catch (error) {
    throw toFeishuApiError(error, '飞书刷新 token 失败')
  }
}

/**
 * 撤销 OAuth access token 或 refresh token。请求使用表单编码，令牌和密钥均不记录到日志或返回值。
 * 飞书可能返回空成功响应，也可能返回带 code/msg 的 JSON，二者均兼容。
 */
export async function revokeOAuthToken({ appId, appSecret, token, tokenTypeHint, signal, client }) {
  const oauthClient = client || createFeishuOAuthSdkClient({ appId, appSecret })
  const payload = await sdkData(
    () => oauthClient.request({
      url: REVOKE_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: {
        client_id: appId,
        client_secret: appSecret,
        token,
        ...(tokenTypeHint ? { token_type_hint: tokenTypeHint } : {}),
      },
      signal,
    }),
    '撤销飞书授权失败',
    { retry: false },
  )
  if (payload?.error || (payload?.code !== undefined && payload.code !== 0 && payload.code !== '0')) {
    throw new Error(payload.error_description || payload.msg || payload.error || '撤销飞书授权失败')
  }
}

export async function getUserInfo({ appId, appSecret, accessToken, client }) {
  // 用户资料请求使用用户身份令牌；该令牌仅放入请求头，不会进入返回对象。
  const apiClient = client || createFeishuOAuthSdkClient({ appId, appSecret })
  const user = await sdkData(
    () => apiClient.authen.v1.userInfo.get({}, withUserAccessToken(accessToken)),
    '获取飞书用户信息失败',
  )
  return requireObject(user, '获取飞书用户信息')
}

export function normalizeToken(token, user) {
  // 飞书响应中的 expires_in 为秒，插件存为本机毫秒时间戳，便于后续直接比较 Date.now()。
  const expiresIn = Number(token.expires_in ?? token.expire ?? 0)
  return {
    // 兼容不同响应字段名，但对外保存的字段名保持稳定。
    accessToken: token.access_token ?? token.user_access_token,
    refreshToken: token.refresh_token,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    // 仅保存插件展示和账户关联所需的最小用户字段。
    user: {
      openId: user.open_id,
      unionId: user.union_id,
      userId: user.user_id,
      name: user.name,
      avatarUrl: user.avatar_url,
    },
  }
}
