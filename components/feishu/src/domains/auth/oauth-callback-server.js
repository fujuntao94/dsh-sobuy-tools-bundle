import { createServer } from 'node:http'
import { localOrigin } from 'sobuy-plugin-core/http'

/**
 * 启动一次性飞书 OAuth 回调服务。
 * 回调页面文案由调用方注入，避免本机 HTTP 生命周期依赖飞书 SDK 或 HTML 模板。
 */
export function startOAuthCallbackServer({
  host,
  port,
  path,
  expectedState,
  timeoutMs,
  signal,
  onAuthorizationCode,
  renderCallbackPage,
}) {
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
    const done = callback => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (!server.listening) {
        callback()
        return
      }
      server.close(callback)
    }
    const fail = error => {
      rejectReady(error)
      done(() => reject(error))
    }
    const succeed = code => done(() => resolve(code))
    const abort = () => fail(new Error('授权已取消'))
    const server = createServer(async (request, response) => {
      const requestUrl = new URL(request.url || '/', localOrigin(host, port))
      if (requestUrl.pathname !== path) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Not Found')
        return
      }
      const code = requestUrl.searchParams.get('code')
      const state = requestUrl.searchParams.get('state')
      if (state !== expectedState) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(renderCallbackPage('飞书授权失败', '授权参数无效或已失效，请回到桌面端重新发起登录。'))
        return
      }
      if (!code) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(renderCallbackPage('飞书授权失败', '飞书未返回授权码，请重新发起登录。'))
        fail(new Error('飞书回调缺少授权码'))
        return
      }
      try {
        const authorizationResult = await onAuthorizationCode(code)
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(renderCallbackPage('飞书授权成功', '登录状态已保存到本机。', { tone: 'success', autoClose: true }))
        succeed(authorizationResult)
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(renderCallbackPage('飞书登录未完成', '飞书已返回授权码，但插件未能换取登录令牌。请检查应用权限和凭据后重试。'))
        fail(error)
      }
    })
    const timeout = setTimeout(() => fail(new Error('等待飞书授权超时，请重新登录')), timeoutMs)
    server.once('error', error => fail(new Error(`无法启动本机授权回调服务：${error.message}`)))
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    server.listen({ host, port, exclusive: true }, () => resolveReady(localOrigin(host, port)))
  })
  return { ready, completed }
}
