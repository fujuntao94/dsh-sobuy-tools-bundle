/**
 * OAuth 协议层：只处理飞书 OAuth 协议、浏览器跳转和本机 HTTP 回调。
 * 工具层不需要知道 HTTP 实现，只调用这里导出的函数。
 */
// Node 内置 HTTP 模块仅用于短生命周期的本地 OAuth 回调服务。
import { createServer } from 'node:http'
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
import { requireObject, requireString } from '../response-validation.js'

// 仅浏览器授权地址与 SDK 尚未语义化封装的撤销地址保留为 URL 常量。
export const AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
export const REVOKE_URL = 'https://accounts.feishu.cn/oauth/v1/revoke'

const CALLBACK_TEMPLATE = readFileSync(new URL('../../ui/pages/callback.html', import.meta.url), 'utf8')
const SETUP_TEMPLATE = readFileSync(new URL('../../ui/pages/setup.html', import.meta.url), 'utf8')

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

/** 只替换模板中明确列出的 {{name}} 占位符，避免把 HTML 拼接逻辑散落在业务代码里。 */
function renderTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => values[name] ?? '')
}

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

/** 将回环监听参数转换为浏览器可访问的本机地址。 */
export function localOrigin(host, port) {
  return `http://${host === '::1' ? '[::1]' : host}:${port}`
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

function readForm(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    let bodyBytes = 0
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      reject(error)
    }
    request.setEncoding('utf8')
    request.on('data', chunk => {
      if (settled) return
      bodyBytes += Buffer.byteLength(chunk)
      // 超出限制后不再保留后续内容，避免异常本机请求持续占用内存。
      if (bodyBytes > 8192) {
        fail(new Error('配置内容过大'))
        request.resume()
        return
      }
      body += chunk
    })
    request.once('error', fail)
    request.once('end', () => {
      if (settled) return
      settled = true
      resolve(new URLSearchParams(body))
    })
  })
}

/**
 * 启动浏览器设置页。这个常驻服务只监听本机回环地址。
 */
export function startSetupPageServer({ host, port, setupPath, statusPath, getStatus, resolveCredentials, beginAuthorization }) {
  const origin = localOrigin(host, port)
  const setupToken = createState()
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', origin)
    const sendPage = async message => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(setupHtml({ setupPath, setupToken, statusPath, message }))
    }
    if (requestUrl.pathname === setupPath && request.method === 'GET') {
      await sendPage()
      return
    }
    // 给页面脚本返回脱敏状态，绝不返回 App Secret 或令牌。
    if (requestUrl.pathname === statusPath && request.method === 'GET') {
      try {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify(await getStatus()))
      } catch {
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: '无法读取飞书登录状态' }))
      }
      return
    }
    if (requestUrl.pathname === setupPath && request.method === 'POST') {
      try {
        const form = await readForm(request)
        if (form.get('setup_token') !== setupToken) {
          await sendPage('设置页已过期，请刷新页面后重试。')
          return
        }
        const credentials = await resolveCredentials({
          appId: form.get('app_id')?.trim(), appSecret: form.get('app_secret')?.trim(),
        })
        if (!credentials.appId || !credentials.appSecret) {
          await sendPage('请填写有效的 App ID 和 App Secret。')
          return
        }
        const authorizationUrl = await beginAuthorization(credentials)
        // 凭据只在本机 POST 请求体中出现；浏览器随后直接跳转飞书官方域名。
        response.writeHead(302, { Location: authorizationUrl, 'Cache-Control': 'no-store' })
        response.end()
      } catch {
        await sendPage('无法保存配置或启动飞书授权，请检查应用信息后重试。')
      }
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not Found')
  })
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port, exclusive: true }, () => {
      server.off('error', reject)
      resolve(`${origin}${setupPath}`)
    })
  })
  return { ready, close: () => new Promise(resolve => server.close(resolve)) }
}

/**
 * 启动一次性本地回调服务并等待飞书重定向。
 * Promise 只有成功拿到授权码、回调异常、超时或用户取消四种结束路径；任一路径均会关闭服务。
 */
export function waitForCallback({ host, port, path, expectedState, timeoutMs, signal, onAuthorizationCode }) {
  let resolveReady
  let rejectReady
  let readySettled = false
  const ready = new Promise((resolve, reject) => {
    resolveReady = value => {
      if (readySettled) return
      readySettled = true
      resolve(value)
    }
    rejectReady = error => {
      if (readySettled) return
      readySettled = true
      reject(error)
    }
  })
  const completed = new Promise((resolve, reject) => {
    let settled = false
    // 统一清理定时器、取消监听器和 HTTP 服务，避免多次回调导致重复 resolve/reject。
    const done = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      // 监听失败时 server 可能尚未处于 listening 状态，此时不能调用 close()。
      if (!server.listening) {
        callback()
        return
      }
      server.close(callback)
    }
    // 将所有失败出口收敛到 done()，保证资源只释放一次。
    const fail = (error) => {
      rejectReady(error)
      done(() => reject(error))
    }
    const succeed = (code) => done(() => resolve(code))
    const abort = () => fail(new Error('授权已取消'))
    // 服务只处理精确 callbackPath；其他路径不泄露任何授权状态。
    const server = createServer(async (request, response) => {
      const requestUrl = new URL(request.url || '/', localOrigin(host, port))
      if (requestUrl.pathname !== path) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Not Found')
        return
      }
      // 飞书授权成功时携带 code 与原样返回的 state。
      const code = requestUrl.searchParams.get('code')
      const state = requestUrl.searchParams.get('state')
      // 不匹配的 state 可能来自旧标签页或本机探测请求：拒绝当前请求，但继续等待真正的回调。
      if (state !== expectedState) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(callbackHtml('飞书授权失败', '授权参数无效或已失效，请回到桌面端重新发起登录。'))
        return
      }
      // state 正确却没有授权码，说明本次授权已结束且无法继续等待。
      if (!code) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(callbackHtml('飞书授权失败', '飞书未返回授权码，请重新发起登录。'))
        fail(new Error('飞书回调缺少授权码'))
        return
      }
      try {
        // 只有令牌已成功交换并保存后才向用户报告成功，避免 OAuth 同意页与本机登录态脱节。
        // 令牌交换必须在成功页之前完成；否则浏览器会显示成功，而实际保存可能失败。
        const authorizationResult = await completeAuthorizationCode(code, onAuthorizationCode)
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(callbackHtml('飞书授权成功', '登录状态已保存到本机。', { tone: 'success', autoClose: true }))
        succeed(authorizationResult)
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(callbackHtml('飞书登录未完成', '飞书已返回授权码，但插件未能换取登录令牌。请检查应用权限和凭据后重试。'))
        fail(error)
      }
    })
    // 授权页面长期闲置时自动回收端口和内存，默认超时时间由插件配置决定。
    const timeout = setTimeout(() => fail(new Error('等待飞书授权超时，请重新登录')), timeoutMs)
    server.once('error', error => fail(new Error(`无法启动本机授权回调服务：${error.message}`)))
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    // exclusive 防止同一端口被多个 callback 服务共享，端口被占用会进入上方 error 分支。
    server.listen({ host, port, exclusive: true }, () => resolveReady(localOrigin(host, port)))
  })
  return { ready, completed }
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
