import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

/** 只替换显式模板占位符，避免设置页散落字符串拼接。 */
export function renderTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => values[name] ?? '')
}

export function createSetupToken() {
  return randomBytes(32).toString('base64url')
}

export function localOrigin(host, port) {
  return `http://${host === '::1' ? '[::1]' : host}:${port}`
}

export function readUrlEncodedForm(request, { maxBytes = 8192 } = {}) {
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
      if (bodyBytes > maxBytes) {
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
 * 创建仅在本机运行的设置页服务。
 * 页面内容、脱敏状态与提交业务由各组件注入；公共层只负责路由、一次性令牌和响应头。
 */
export function createLocalSetupServer({
  host,
  port,
  setupPath,
  statusPath,
  renderPage,
  getStatus,
  submit,
  statusError = '无法读取设置状态',
  bodyLimitBytes,
  onError = () => {},
}) {
  const origin = localOrigin(host, port)
  let setupToken = createSetupToken()
  const sendPage = async (response, { message = '', tone = 'error' } = {}) => {
    const page = await renderPage({ setupToken, message, tone })
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(page)
  }
  const sendInternalError = response => {
    if (response.headersSent) {
      response.end()
      return
    }
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end('设置页暂时不可用，请稍后重试。')
  }
  const handleRequest = async (request, response) => {
    const requestUrl = new URL(request.url || '/', origin)
    if (requestUrl.pathname === setupPath && request.method === 'GET') {
      await sendPage(response)
      return
    }
    if (requestUrl.pathname === statusPath && request.method === 'GET') {
      try {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify(await getStatus()))
      } catch (error) {
        onError(error)
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ error: statusError }))
      }
      return
    }
    if (requestUrl.pathname === setupPath && request.method === 'POST') {
      try {
        const contentType = request.headers['content-type'] || ''
        if (!contentType.startsWith('application/x-www-form-urlencoded')) {
          await sendPage(response, { message: '设置提交格式无效，请刷新页面后重试。' })
          return
        }
        const form = await readUrlEncodedForm(request, { maxBytes: bodyLimitBytes })
        if (form.get('setup_token') !== setupToken) {
          await sendPage(response, { message: '设置页已过期，请刷新页面后重试。' })
          return
        }
        // 令牌在业务保存前立即轮换，阻止并发或重放请求复用同一份表单。
        setupToken = createSetupToken()
        const result = await submit(form)
        if (result?.redirect) {
          response.writeHead(302, { Location: result.redirect, 'Cache-Control': 'no-store' })
          response.end()
          return
        }
        await sendPage(response, result)
      } catch (error) {
        await sendPage(response, { message: error instanceof Error ? error.message : '无法保存设置，请检查后重试。' })
      }
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not Found')
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(error => {
      onError(error)
      sendInternalError(response)
    })
  })
  const ready = new Promise((resolve, reject) => {
    const rejectStartup = error => reject(error)
    server.once('error', rejectStartup)
    server.listen({ host, port, exclusive: true }, () => {
      server.off('error', rejectStartup)
      // 启动成功后的底层错误也必须有监听器，避免 Node 将其升级为未处理异常。
      server.on('error', onError)
      resolve(`${origin}${setupPath}`)
    })
  })
  return {
    ready,
    close: () => new Promise(resolve => {
      if (!server.listening) return resolve()
      server.close(() => resolve())
    }),
  }
}
