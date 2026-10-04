/**
 * 登录工具的入口流程：
 * 1. 插件加载时调用 registerLoginTool，启动浏览器设置页并注册 feishu_login。
 * 2. 智能体调用 feishu_login 时，execute 根据 action 进入对应分支。
 * 3. 只有 login / refresh / logout 才会访问飞书；status 只读本地文件。
 *
 * 这个文件只管理 OAuth 登录。所有模型可调用的 Tool 都放在 runtime/tools/；
 * 具体 OAuth 实现位于 domains/auth/。
 */
import {
  createAuthorizationFlow,
  openInBrowser,
} from '../../domains/auth/oauth.js'
import { logout } from '../../domains/auth/logout.js'
import { createSetupPageServer, saveAuthorizationResult } from '../../domains/auth/setup-page.js'
import { refreshStoredUserToken } from '../../domains/auth/user-token.js'
import {
  configPath,
  defaultDataDirectory,
  readJson,
  tokenPath,
} from '../../domains/auth/token-store.js'

// action 是智能体调用工具时唯一需要传入的参数。
const LOGIN_ACTIONS = ['login', 'status', 'refresh', 'logout']

/**
 * 将内部 token 文件转成工具输出。
 * 注意：工具输出会进入模型上下文，所以这里只能返回是否登录、过期时间和脱敏用户资料。
 */
export function publicStatus(token, configured) {
  if (!token) return { configured, loggedIn: false }
  return {
    configured,
    loggedIn: true,
    expiresAt: token.expiresAt,
    // 登录状态只用于确认“是谁已登录”；内部用户标识和头像不应进入工具结果。
    user: token.user?.name ? { name: token.user.name } : undefined,
  }
}

/**
 * App ID、App Secret 和回调地址都齐全，才视为可以发起登录。
 * 这只返回 true/false，不会把 Secret 返回给调用方。
 */
export function hasApplicationCredentials(config) {
  return Boolean(config?.appId && config?.appSecret && config?.redirectUri)
}

function parseAction(args) {
  // DSH 原生工具的参数类型是 unknown；先在边界处校验，后面的代码才可安全分支。
  const action = args && typeof args === 'object' ? args.action : undefined
  if (!LOGIN_ACTIONS.includes(action)) {
    throw new Error(`action 必须是 ${LOGIN_ACTIONS.join('、')}。`)
  }
  return action
}

async function readCredentials(dataDirectory) {
  // 凭据只从私有文件读取，绝不让模型在工具参数中传入 App Secret。
  const credentials = await readJson(configPath(dataDirectory))
  if (!hasApplicationCredentials(credentials)) {
    throw new Error(`请先在设置页填写 App ID 和 App Secret。配置文件位置：${configPath(dataDirectory)}`)
  }
  return credentials
}

/** 从插件配置读取所有本机端口和路径，并在启动服务器前验证。 */
function readLoginOptions(config) {
  // config 来自 cordis.patch.yml；这些是插件运行位置，不是用户输入。
  const options = {
    callbackHost: config.callbackHost || '127.0.0.1',
    callbackPort: Number(config.callbackPort || 18080),
    callbackPath: config.callbackPath || '/feishu/callback',
    setupPort: Number(config.setupPort || 18081),
    setupPath: config.setupPath || '/feishu/setup',
    statusPath: config.statusPath || '/feishu/status',
    oauthScope: config.oauthScope || 'offline_access contact:user.base:readonly contact:user.department:readonly contact:department.base:readonly',
    authorizationTimeoutMs: Number(config.authorizationTimeoutMs || 300000),
    dataDirectory: config.dataDirectory || defaultDataDirectory(),
  }
  const allPaths = [
    options.callbackPath,
    options.setupPath,
    options.statusPath,
  ]

  // 设置页和 OAuth 回调必须分开监听，且每个本地 URL 路径必须唯一。
  const invalidPort = !Number.isInteger(options.callbackPort) || options.callbackPort < 1 || options.callbackPort > 65535
    || !Number.isInteger(options.setupPort) || options.setupPort < 1 || options.setupPort > 65535
    || options.callbackPort === options.setupPort
  if (invalidPort || !['127.0.0.1', '::1'].includes(options.callbackHost) || allPaths.some(path => !path.startsWith('/')) || new Set(allPaths).size !== allPaths.length || !options.oauthScope.trim()) {
    throw new Error('飞书工具插件的本机回调端口或路径配置无效。')
  }
  return options
}

function buildRedirectUri({ callbackHost, callbackPort, callbackPath }) {
  // IPv6 URL 的主机名必须使用方括号包裹，例如 http://[::1]:18080/...
  const host = callbackHost === '::1' ? '[::1]' : callbackHost
  return `http://${host}:${callbackPort}${callbackPath}`
}

function assertRedirectUri(options, redirectUri) {
  // 飞书后台登记的回调地址必须完全一致；同时限制为回环地址，避免授权码出现在公网服务。
  if (!['127.0.0.1', '::1'].includes(options.callbackHost)) {
    throw new Error('飞书工具插件仅允许监听 127.0.0.1 或 ::1，不能暴露授权回调到网络。')
  }
  const expected = new URL(buildRedirectUri(options))
  const actual = new URL(redirectUri)
  if (actual.protocol !== expected.protocol || actual.host !== expected.host || actual.pathname !== expected.pathname || actual.search || actual.hash) {
    throw new Error(`config.json 的 redirectUri 必须精确为 ${expected.toString()}，并同时登记到飞书开放平台。`)
  }
}

function loginToolDefinition({ options, redirectUri, onIdentityChanged = () => {}, telemetry, authService }) {
  // ToolDefinition 是 DSH 识别工具的结构：名称、入参 JSON Schema、输出 Schema、执行函数。
  return {
    name: 'feishu_login',
    description: '管理本机飞书 OAuth：status、login、refresh、logout。未配置时前往设置页；仅监听回环地址。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: LOGIN_ACTIONS,
          description: '操作类型。首次使用需先在设置页配置应用凭据。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'loggedIn'],
        properties: {
          action: { type: 'string' },
          configured: { type: 'boolean' },
          loggedIn: { type: 'boolean' },
          expiresAt: { type: 'number' },
          user: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: !value.configured
          ? '飞书应用尚未配置。请先到“设置 → 插件 → 飞书工具”打开浏览器设置页，填写 App ID 和 App Secret，再重新调用登录。'
          : value.loggedIn
            ? `飞书已登录${value.user?.name ? `：${value.user.name}` : ''}`
            : '飞书应用已配置，但当前未登录；请调用 login 发起飞书 OAuth 授权登录。',
      }],
    },
    async execute(args, exec) {
      return telemetry.run({ tool: 'feishu_login', exec }, async () => {
        const action = parseAction(args)

        if (action === 'status') {
          // 最安全、最轻量的分支：只读取本地状态，不访问网络，也不需要完整凭据。
          const [credentials, token] = await Promise.all([
            readJson(configPath(options.dataDirectory)),
            readJson(tokenPath(options.dataDirectory)),
          ])
          return { action, ...publicStatus(token, hasApplicationCredentials(credentials)) }
        }

        if (action === 'logout') {
          // logout 会撤销远端 token，因此传入 DSH 的取消信号以便用户中途停止操作。
          await logout({ dataDirectory: options.dataDirectory, signal: exec.signal })
          onIdentityChanged()
          // 撤销期间若已有更新的登录完成，logout 会保留新 token；返回值必须反映最终存储状态。
          const [credentials, token] = await Promise.all([
            readJson(configPath(options.dataDirectory)),
            readJson(tokenPath(options.dataDirectory)),
          ])
          return {
            action,
            ...publicStatus(token, hasApplicationCredentials(credentials)),
          }
        }

        // login 未配置时只返回提示，让智能体先引导用户到设置页。
        const savedConfig = await readJson(configPath(options.dataDirectory))
        if (action === 'login' && !hasApplicationCredentials(savedConfig)) {
          return { action, ...publicStatus(await readJson(tokenPath(options.dataDirectory)), false) }
        }

        if (action === 'refresh') {
          // refresh 不打开浏览器，与业务工具的自动刷新共用同一套 token 刷新实现。
          const refreshed = authService
            ? await authService.refreshCurrentUser({ signal: exec.signal })
            : await refreshStoredUserToken({ dataDirectory: options.dataDirectory, signal: exec.signal })
          onIdentityChanged()
          return { action, ...publicStatus(refreshed.token, true) }
        }

        const credentials = await readCredentials(options.dataDirectory)
        assertRedirectUri(options, credentials.redirectUri)

        // login：先监听回调，再打开飞书浏览器页，防止用户确认太快而丢失回调。
        const { authorizationUrl, ready, completed } = createAuthorizationFlow({
          appId: credentials.appId,
          redirectUri,
          scope: options.oauthScope,
          host: options.callbackHost,
          port: options.callbackPort,
          path: options.callbackPath,
          timeoutMs: options.authorizationTimeoutMs,
          signal: exec.signal,
          onAuthorizationCode: code => saveAuthorizationResult({
            credentials, redirectUri, code, dataDirectory: options.dataDirectory, signal: exec.signal,
          }),
        })
        // 先观察 completed，避免端口绑定失败时 ready 与 completed 同时拒绝而产生未处理 Promise。
        void completed.catch(() => {})
        await ready
        openInBrowser(authorizationUrl)

        // 回调服务已在展示成功页前完成换 token 和私有保存。
        const token = await completed
        onIdentityChanged()
        return { action, ...publicStatus(token, true) }
      }, value => ({ action: value.action, configured: value.configured, loggedIn: value.loggedIn }))
    },
  }
}

/** 插件入口调用这个函数注册登录工具。 */
export function registerLoginTool(ctx, config = {}) {
  // 这里是模块的唯一入口：准备依赖，然后将工具交给 DSH 注册。
  const options = readLoginOptions(config)
  const redirectUri = buildRedirectUri(options)
  const setupPage = createSetupPageServer(ctx, options, redirectUri)

  // 设置页端口被占用时不让 Promise 静默失败，同时保留插件其他工具的可用性。
  void setupPage.ready.catch(error => ctx.logger?.warn('飞书设置页未启动：%s', error.message))
  ctx.effect(() => () => setupPage.close(), 'sobuy-feishu-tools: setup page server')
  ctx.tools.register(loginToolDefinition({
    options,
    redirectUri,
    onIdentityChanged: () => ctx.feishuAuth?.clearCurrentUserCache(),
    telemetry: ctx.feishuTelemetry,
    authService: ctx.feishuAuth,
  }))
}
