/** 浏览器设置页：只负责脱敏展示和保存数据库连接配置。 */
import { readFileSync } from 'node:fs'
import { readConfig, writePrivateConfig } from './storage/config-store.js'
import { normalizeSecurityPolicy, publicSecurityPolicy } from './security/policy.js'
import { createLocalSetupServer, escapeHtml, renderTemplate } from 'sobuy-plugin-core/http'

const SETUP_TEMPLATE = readFileSync(new URL('./ui/setup.html', import.meta.url), 'utf8')

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
  return createLocalSetupServer({
    host: options.setupHost,
    port: options.setupPort,
    setupPath: options.setupPath,
    statusPath: options.statusPath,
    bodyLimitBytes: 32768,
    renderPage: ({ setupToken, message, tone }) => setupHtml({
        setupPath: options.setupPath,
        statusPath: options.statusPath,
        setupToken,
        message,
        tone,
      }),
    getStatus: async () => publicDatabaseStatus(await readConfig(options.dataDirectory)),
    statusError: '无法读取数据库配置',
    onError: error => options.logger?.warn('数据库设置页请求失败：%s', error.message),
    submit: async form => {
      try {
        const previous = await readConfig(options.dataDirectory)
        const config = normalizeDatabaseConfig({
          host: form.get('host'),
          port: form.get('port'),
          database: form.get('database'),
          username: form.get('username'),
          password: form.get('password'),
          ssl: form.get('ssl'),
          maxRows: form.get('max_rows'),
          queryTimeoutMs: form.get('query_timeout_ms'),
          sensitiveFields: form.get('sensitive_fields'),
        }, previous)
        await writePrivateConfig(config, options.dataDirectory)
        return { message: '数据库配置已保存到本机。', tone: 'success' }
      } catch (error) {
        return { message: error instanceof Error ? error.message : '无法保存数据库配置，请检查后重试。' }
      }
    },
  })
}
