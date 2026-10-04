/** 浏览器设置页：只负责脱敏展示和保存数据库连接配置。 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { readConfig, writePrivateConfig } from './storage/config-store.js'
import { normalizeSecurityPolicy, publicSecurityPolicy } from './security/policy.js'

const SETUP_TEMPLATE = readFileSync(new URL('./ui/setup.html', import.meta.url), 'utf8')

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function renderTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => values[name] ?? '')
}

function createSetupToken() {
  return randomBytes(32).toString('base64url')
}

function localOrigin(host, port) {
  return `http://${host === '::1' ? '[::1]' : host}:${port}`
}

function readForm(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      body += chunk
      if (Buffer.byteLength(body) > 32768) reject(new Error('配置内容过大'))
    })
    request.once('error', reject)
    request.once('end', () => resolve(new URLSearchParams(body)))
  })
}

function normalizeRequired(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeDatabaseConfig(input, previous) {
  const port = Number(input.port)
  // 密码可能合法包含首尾空格；只有完全空字符串才表示继续使用已保存密码。
  const submittedPassword = typeof input.password === 'string' ? input.password : ''
  const next = {
    type: 'mysql',
    host: normalizeRequired(input.host),
    port,
    database: normalizeRequired(input.database),
    username: normalizeRequired(input.username),
    password: submittedPassword || previous?.password || '',
    ssl: input.ssl === true || input.ssl === 'true' || input.ssl === 'on',
    ...normalizeSecurityPolicy({
      allowedTables: input.allowedTables,
      maxRows: input.maxRows,
      queryTimeoutMs: input.queryTimeoutMs,
      sensitiveFields: input.sensitiveFields,
    }, previous),
  }
  if (!next.host || !Number.isInteger(port) || port < 1 || port > 65535 || !next.database || !next.username || !next.password) {
    throw new Error('请完整填写主机、端口、数据库名、用户名和密码。')
  }
  return next
}

export function publicDatabaseStatus(config) {
  if (!config) return { configured: false }
  return {
    configured: Boolean(config.host && config.port && config.database && config.username && config.password),
    type: config.type || 'mysql',
    host: config.host || '',
    port: config.port || 3306,
    database: config.database || '',
    username: config.username || '',
    passwordConfigured: Boolean(config.password),
    ssl: Boolean(config.ssl),
    ...publicSecurityPolicy(config),
  }
}

export function setupHtml({ setupPath, statusPath, setupToken, message = '', tone = 'error' }) {
  return renderTemplate(SETUP_TEMPLATE, {
    setupPath: escapeHtml(setupPath),
    statusPath: escapeHtml(statusPath),
    setupToken: escapeHtml(setupToken),
    message: escapeHtml(message),
    noticeHidden: message ? '' : 'hidden',
    noticeTone: tone === 'success' ? 'success' : 'error',
  })
}

export function createDatabaseSetupServer(options) {
  const origin = localOrigin(options.setupHost, options.setupPort)
  const setupToken = createSetupToken()
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', origin)
    const sendPage = (message = '', tone = 'error') => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(setupHtml({
        setupPath: options.setupPath,
        statusPath: options.statusPath,
        setupToken,
        message,
        tone,
      }))
    }

    if (requestUrl.pathname === options.setupPath && request.method === 'GET') {
      sendPage()
      return
    }
    if (requestUrl.pathname === options.statusPath && request.method === 'GET') {
      try {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify(publicDatabaseStatus(await readConfig(options.dataDirectory))))
      } catch {
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ error: '无法读取数据库配置' }))
      }
      return
    }
    if (requestUrl.pathname === options.setupPath && request.method === 'POST') {
      try {
        const form = await readForm(request)
        if (form.get('setup_token') !== setupToken) {
          sendPage('设置页已过期，请刷新页面后重试。')
          return
        }
        const previous = await readConfig(options.dataDirectory)
        const config = normalizeDatabaseConfig({
          host: form.get('host'),
          port: form.get('port'),
          database: form.get('database'),
          username: form.get('username'),
          password: form.get('password'),
          ssl: form.get('ssl'),
          allowedTables: form.get('allowed_tables'),
          maxRows: form.get('max_rows'),
          queryTimeoutMs: form.get('query_timeout_ms'),
          sensitiveFields: form.get('sensitive_fields'),
        }, previous)
        await writePrivateConfig(config, options.dataDirectory)
        sendPage('数据库配置已保存到本机。', 'success')
      } catch (error) {
        sendPage(error instanceof Error ? error.message : '无法保存数据库配置，请检查后重试。')
      }
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not Found')
  })

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: options.setupHost, port: options.setupPort, exclusive: true }, () => {
      server.off('error', reject)
      resolve(`${origin}${options.setupPath}`)
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
