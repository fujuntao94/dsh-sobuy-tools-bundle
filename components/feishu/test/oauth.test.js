// 使用 Node 内置测试框架，避免测试本身引入额外运行时依赖。
import test from 'node:test'
// strict 断言保证 URL 编码和令牌字段映射不被后续重构悄悄改变。
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// 只测试不需要真实飞书凭据的纯函数，避免单测访问网络或泄露令牌。
import { hasApplicationCredentials, publicStatus, registerLoginTool } from '../src/runtime/tools/login-tool.js'
import { getValidUserToken } from '../src/domains/auth/user-token.js'
import { registerUserInfoTool } from '../src/runtime/tools/user-info-tool.js'
import { registerDepartmentTool } from '../src/runtime/tools/department-tool.js'
import { getMyDepartments } from '../src/domains/organization/department-api.js'
import { createFeishuSdkClient } from '../src/domains/auth/feishu-sdk.js'
import { feishuErrorDiagnostic, toFeishuApiError } from '../src/domains/auth/feishu-error.js'
import { getMyLeaveBalances } from '../src/domains/leave/leave-balance-api.js'
import { publicLeaveBalances, registerLeaveBalanceTool } from '../src/runtime/tools/leave-balance-tool.js'
import { registerLeaveBalanceSkill } from '../src/runtime/skills/leave-balance-skill.js'
import { registerLeaveBalanceDiagnoseSkill } from '../src/runtime/skills/leave-balance-diagnose-skill.js'
import { registerLoginGuideSkill } from '../src/runtime/skills/login-guide-skill.js'
import { registerUserInfoSkill } from '../src/runtime/skills/user-info-skill.js'
import { registerOrganizationSkill } from '../src/runtime/skills/organization-skill.js'
import { registerCapabilityBoundarySkill } from '../src/runtime/skills/capability-boundary-skill.js'
import { registerCapabilitiesTool } from '../src/runtime/tools/capabilities-tool.js'
import { registerFeishuCapabilityGuard } from '../src/runtime/guards/feishu-capability-guard.js'
import { createFeishuAuthService, provideFeishuAuthService } from '../src/runtime/services/feishu-auth-service.js'
import { createOperationTelemetryService } from '../src/runtime/services/operation-telemetry-service.js'
import { registerOperationLogTool } from '../src/runtime/tools/operation-log-tool.js'
import { registerFeishuToolHooks } from '../src/runtime/hooks/feishu-tool-hooks.js'
import {
  buildAuthorizeUrl,
  callbackHtml,
  completeAuthorizationCode,
  exchangeAuthorizationCode,
  getUserInfo,
  normalizeToken,
  refreshAccessToken,
  REVOKE_URL,
  revokeOAuthToken,
  setupHtml,
} from '../src/domains/auth/oauth.js'
import { authorizationStatusPath, configPath, readJson, tokenPath, writePrivateJson } from '../src/domains/auth/token-store.js'
import { readFile } from 'node:fs/promises'
import packageJson from '../../../package.json' with { type: 'json' }

test('OAuth v2 授权链接会编码回调地址、范围并保留 state', () => {
  // 模拟实际 OAuth 参数；这里只验证 URL 结构，不会打开浏览器。
  const url = new URL(buildAuthorizeUrl({ appId: 'cli_test', redirectUri: 'http://127.0.0.1:18080/feishu/callback', state: 'safe-state' }))
  assert.equal(url.searchParams.get('client_id'), 'cli_test')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('scope'), 'offline_access contact:user.base:readonly')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:18080/feishu/callback')
  assert.equal(url.searchParams.get('state'), 'safe-state')
})

test('撤销令牌走飞书 OAuth 账户域名', () => {
  assert.equal(REVOKE_URL, 'https://accounts.feishu.cn/oauth/v1/revoke')
})

test('飞书错误保留原始信息，同时生成可诊断但不含凭据的分类', () => {
  const error = toFeishuApiError({ response: { status: 403, data: { code: 99991672, msg: 'no permission' } } }, 'fallback')
  assert.equal(error.message, 'no permission')
  assert.equal(error.kind, 'permission')
  assert.deepEqual(feishuErrorDiagnostic(error), { kind: 'permission', code: '99991672', status: 403 })
})

test('OAuth 换取、刷新、撤销和用户资料均通过 SDK Client 调用', async () => {
  const calls = []
  const client = {
    accessToken: {
      retrieveByAuthorizationCode: async payload => {
        calls.push({ api: 'accessToken.retrieveByAuthorizationCode', payload })
        return { accessToken: 'access-token', refreshToken: 'refresh-token', expiresIn: 7200 }
      },
      refresh: async payload => {
        calls.push({ api: 'accessToken.refresh', payload })
        return { accessToken: 'new-access-token', refreshToken: 'new-refresh-token', expiresIn: 7200 }
      },
    },
    authen: { v1: { userInfo: { get: async (_payload, options) => {
      calls.push({ api: 'authen.v1.userInfo.get', options })
      return { code: 0, data: { name: '测试用户', open_id: 'ou_current' } }
    } } } },
    request: async payload => {
      calls.push({ api: 'request', payload })
      return {}
    },
  }

  const exchanged = await exchangeAuthorizationCode({ appId: 'cli_test', appSecret: 'test-secret', redirectUri: 'http://127.0.0.1/callback', code: 'code', client })
  assert.equal(exchanged.access_token, 'access-token')
  assert.deepEqual(calls[0].payload, { code: 'code', redirectUri: 'http://127.0.0.1/callback' })

  const refreshed = await refreshAccessToken({ appId: 'cli_test', appSecret: 'test-secret', refreshToken: 'refresh-token', client })
  assert.equal(refreshed.refresh_token, 'new-refresh-token')
  assert.deepEqual(calls[1].payload, { refreshToken: 'refresh-token' })

  const user = await getUserInfo({ accessToken: 'new-access-token', client })
  assert.equal(user.name, '测试用户')
  assert.equal(calls[2].api, 'authen.v1.userInfo.get')

  await revokeOAuthToken({ appId: 'cli_test', appSecret: 'test-secret', token: 'refresh-token', tokenTypeHint: 'refresh_token', client })
  assert.equal(calls[3].api, 'request')
  assert.equal(calls[3].payload.url, REVOKE_URL)
  assert.equal(calls[3].payload.data.token_type_hint, 'refresh_token')
})

test('令牌保存结构不保留未使用的原始响应字段', () => {
  // 使用虚构凭据确认规范化后只留下插件真正需要的字段。
  const token = normalizeToken({ access_token: 'secret', refresh_token: 'refresh', expires_in: 60 }, { open_id: 'ou_x', name: '测试用户' })
  assert.equal(token.accessToken, 'secret')
  assert.equal(token.user.openId, 'ou_x')
  assert.equal(token.user.name, '测试用户')
  assert.equal('unused' in token, false)
})

test('缺少 refresh token 时仍保留可用的用户 access token', () => {
  const token = normalizeToken({ access_token: 'access-only', expires_in: 60 }, { open_id: 'ou_x', name: '测试用户' })
  assert.equal(token.accessToken, 'access-only')
  assert.equal(token.refreshToken, undefined)
})

test('授权成功页提供六秒倒计时关闭，且不回显授权参数', () => {
  const html = callbackHtml('飞书授权成功', '登录状态已保存到本机。', { tone: 'success', autoClose: true })
  assert.match(html, /data-auto-close-seconds="6"/)
  assert.match(html, /window\.close\(\)/)
  assert.doesNotMatch(html, /authorization_code|access_token|refresh_token/)
})

test('OAuth 回调会等待令牌保存完成，再返回保存结果', async () => {
  let saved = false
  const result = await completeAuthorizationCode('auth-code', async code => {
    assert.equal(code, 'auth-code')
    await Promise.resolve()
    saved = true
    return { accessToken: 'saved-token' }
  })
  assert.equal(saved, true)
  assert.deepEqual(result, { accessToken: 'saved-token' })
})

test('浏览器设置页包含凭据表单和一次性提交令牌', () => {
  const html = setupHtml({ setupPath: '/feishu/setup', statusPath: '/feishu/status', setupToken: 'one-time-token' })
  assert.match(html, /name="app_id"/)
  assert.match(html, /name="app_secret"/)
  assert.match(html, /name="setup_token" value="one-time-token"/)
  assert.match(html, /fetch\('\/feishu\/status'/)
  assert.doesNotMatch(html, /replace_me/)
})

test('应用凭据可被原子私有保存', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-feishu-login-'))
  const file = join(folder, 'config.json')
  try {
    await writePrivateJson(file, { appId: 'cli_test', appSecret: 'test-secret', redirectUri: 'http://127.0.0.1:18080/feishu/callback' })
    assert.deepEqual(await readJson(file), { appId: 'cli_test', appSecret: 'test-secret', redirectUri: 'http://127.0.0.1:18080/feishu/callback' })
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('个人信息工具复用未过期的用户 token，不重复刷新', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-feishu-user-token-'))
  try {
    await writePrivateJson(configPath(folder), { appId: 'cli_test', appSecret: 'test-secret' })
    await writePrivateJson(tokenPath(folder), { accessToken: 'access-only', refreshToken: 'refresh', expiresAt: Date.now() + 10 * 60 * 1000 })
    const active = await getValidUserToken({ dataDirectory: folder })
    assert.equal(active.refreshed, false)
    assert.equal(active.token.accessToken, 'access-only')
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('授权结果路径与令牌分离，便于展示脱敏错误', () => {
  assert.equal(authorizationStatusPath('/tmp/feishu-login'), '/tmp/feishu-login/authorization-status.json')
})

test('Desktop 设置页提供浏览器设置页入口', async () => {
  const client = await readFile(new URL('../../../client.js', import.meta.url), 'utf8')
  assert.match(client, /feishu\/setup/)
  assert.match(client, /openSetupPage/)
})

test('登录工具会区分未配置与已配置但未登录的状态', async () => {
  assert.equal(hasApplicationCredentials(undefined), false)
  assert.equal(hasApplicationCredentials({ appId: 'cli_test', appSecret: 'test-secret' }), false)
  assert.equal(hasApplicationCredentials({ appId: 'cli_test', appSecret: 'test-secret', redirectUri: 'http://127.0.0.1:18080/feishu/callback' }), true)
  assert.deepEqual(publicStatus(undefined, false), { configured: false, loggedIn: false })
  assert.deepEqual(publicStatus(undefined, true), { configured: true, loggedIn: false })
})

test('插件拒绝非回环地址，避免设置页或 OAuth 回调暴露到网络', () => {
  assert.throws(
    () => registerLoginTool({}, { callbackHost: '0.0.0.0' }),
    /仅允许监听 127\.0\.0\.1 或 ::1|本机回调端口或路径配置无效/,
  )
})

test('个人信息与我的部门工具已注册，部门工具不需要调用参数', () => {
  const tools = []
  const ctx = { tools: { register: tool => tools.push(tool) } }
  registerUserInfoTool(ctx, { dataDirectory: '/tmp/feishu-user-info-test' })
  registerDepartmentTool(ctx, { dataDirectory: '/tmp/feishu-department-test' })
  registerLeaveBalanceTool(ctx, { dataDirectory: '/tmp/feishu-leave-balance-test' })
  registerOperationLogTool(ctx)
  assert.deepEqual(tools.map(tool => tool.name), ['feishu_user_info', 'feishu_my_departments', 'feishu_my_leave_balances', 'feishu_operation_logs'])
  assert.match(tools[0].description, /自动刷新/)
  assert.match(tools[0].output.render({}, { refreshed: false, user: { name: '测试用户', enterpriseEmail: 'work@example.com', mobile: '13800000000' } })[0].text, /邮箱：work@example\.com；手机号：13800000000/)
  assert.match(tools[0].output.render({}, { refreshed: false, user: { name: '测试用户', email: 'personal@example.com' } })[0].text, /邮箱：personal@example\.com；手机号：未获取到/)
  assert.match(tools[0].output.render({}, { refreshed: false, user: { name: '测试用户' } })[0].text, /手机号：未获取到/)
  assert.match(tools[1].description, /无需也不能传入用户 ID/)
  assert.deepEqual(tools[1].parameters.properties, {})
  assert.deepEqual(tools[1].output.schema.required, ['departments'])
  assert.equal(tools[1].output.schema.properties.departments.items.additionalProperties, false)
  assert.equal('openDepartmentId' in tools[1].output.schema.properties.departments.items.properties, false)
  assert.match(tools[1].output.render({}, { departments: [{ name: '研发部', leaderNames: ['部门负责人'] }] })[0].text, /负责人：部门负责人/)
  assert.equal('refreshed' in tools[1].output.schema.properties, false)
  assert.deepEqual(tools[2].parameters.properties, {})
  assert.match(tools[2].description, /不能传入用户 ID/)
  assert.match(tools[3].description, /当前会话/)
  assert.equal(tools[3].output.schema.properties.operations.items.properties.errorKind.type, 'string')
  assert.equal(tools[3].output.schema.properties.operations.items.properties.errorCode.type, 'string')
  assert.equal(tools[3].output.schema.properties.operations.items.properties.errorStatus.type, 'number')
})

test('操作日志按 DSH 会话隔离，并对错误中的凭据脱敏', async () => {
  const entries = []
  const telemetry = createOperationTelemetryService({ logger: { info: entry => entries.push(entry), warn: entry => entries.push(entry) } })
  const firstSession = { agent: { id: 'session-one' } }
  const secondSession = { agent: { id: 'session-two' } }
  await telemetry.run({ tool: 'feishu_my_leave_balances', exec: firstSession }, async () => ({ balances: [] }), value => ({ balanceTypeCount: value.balances.length }))
  await assert.rejects(
    telemetry.run({ tool: 'feishu_my_departments', exec: firstSession }, async () => { throw new Error('Bearer secret-value access_token=another-secret') }),
    /secret-value/,
  )
  assert.equal(telemetry.recent(firstSession).length, 2)
  assert.equal(telemetry.recent(secondSession).length, 0)
  assert.match(telemetry.recent(firstSession)[1].error, /\[REDACTED\]/)
  assert.doesNotMatch(telemetry.recent(firstSession)[1].error, /secret-value|another-secret/)
  assert.equal(entries.length, 4)
})


test('tools/result Hook 仅补记飞书 Tool 在本体执行前失败的最终结果', () => {
  const telemetry = createOperationTelemetryService({ logger: { info: () => {}, warn: () => {} } })
  const listeners = []
  const dispose = () => {}
  const ctx = { feishuTelemetry: telemetry, on: (name, listener) => { listeners.push({ name, listener }); return dispose } }
  assert.equal(registerFeishuToolHooks(ctx), dispose)
  assert.deepEqual(listeners.map(item => item.name), ['tools/result'])

  const exec = { name: 'feishu_my_leave_balances', callId: 'call-blocked', agent: { id: 'session-one' } }
  listeners[0].listener(exec, { isError: true })
  listeners[0].listener(exec, { isError: true })
  listeners[0].listener({ name: 'unrelated_tool', callId: 'call-other', agent: { id: 'session-one' } }, { isError: true })

  const records = telemetry.recent({ agent: { id: 'session-one' } })
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'error')
  assert.equal(records[0].summary.source, 'tools/result')
})

test('飞书认证 Service 统一返回当前 OAuth 用户的 open_id', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-feishu-auth-service-'))
  try {
    await writePrivateJson(configPath(folder), { appId: 'cli_test', appSecret: 'test-secret' })
    await writePrivateJson(tokenPath(folder), {
      accessToken: 'access-token',
      expiresAt: Date.now() + 10 * 60 * 1000,
      user: { openId: 'ou_current', name: '测试用户' },
    })
    const service = createFeishuAuthService({ dataDirectory: folder })
    const { active, openId } = await service.getCurrentOpenId()
    assert.equal(openId, 'ou_current')
    assert.equal(active.token.accessToken, 'access-token')
    // 已缓存的身份不再读取 token 文件；登录状态变化后可主动清除。
    await rm(tokenPath(folder), { force: true })
    assert.equal((await service.getCurrentOpenId()).openId, 'ou_current')
    service.clearCurrentUserCache()
    await assert.rejects(service.getCurrentOpenId(), /尚未完成飞书授权/)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('飞书认证 Service 合并并发的用户 token 加载，避免重复刷新', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-feishu-auth-single-flight-'))
  try {
    await writePrivateJson(configPath(folder), { appId: 'cli_test', appSecret: 'test-secret' })
    let calls = 0
    const service = createFeishuAuthService({
      dataDirectory: folder,
      getValidUserTokenImpl: async () => {
        calls += 1
        await new Promise(resolve => setTimeout(resolve, 5))
        return { token: { accessToken: 'access-token', expiresAt: Date.now() + 10 * 60 * 1000, user: { openId: 'ou_current' } }, refreshed: true }
      },
    })
    const [first, second] = await Promise.all([service.getActiveUser(), service.getActiveUser()])
    assert.equal(calls, 1)
    assert.equal(first.token.accessToken, second.token.accessToken)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('取消一个等待中的 Tool 不会取消共享的用户 token 刷新', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-feishu-auth-cancel-'))
  try {
    await writePrivateJson(configPath(folder), { appId: 'cli_test', appSecret: 'test-secret' })
    let calls = 0
    const service = createFeishuAuthService({
      dataDirectory: folder,
      getValidUserTokenImpl: async () => {
        calls += 1
        await new Promise(resolve => setTimeout(resolve, 10))
        return { token: { accessToken: 'access-token', expiresAt: Date.now() + 10 * 60 * 1000, user: { openId: 'ou_current' } }, refreshed: true }
      },
    })
    const controller = new AbortController()
    const cancelled = service.getActiveUser({ signal: controller.signal })
    const retained = service.getActiveUser()
    controller.abort()
    await assert.rejects(cancelled, /已取消/)
    assert.equal((await retained).token.accessToken, 'access-token')
    assert.equal(calls, 1)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('飞书认证 Service 使用 ctx.provide 绑定插件生命周期', () => {
  const provided = []
  const ctx = { provide: (name, service) => provided.push({ name, service }) }
  const service = provideFeishuAuthService(ctx, { dataDirectory: '/tmp/feishu-auth-service-test' })
  assert.equal(provided.length, 1)
  assert.equal(provided[0].name, 'feishuAuth')
  assert.equal(provided[0].service, service)
})

test('我的部门查询从用户响应的 data.user.department_ids 读取部门引用并换取详情', async () => {
  const requests = []
  const client = {
    contact: { v3: {
      user: { get: async payload => {
        requests.push({ api: 'user.get', payload })
        if (payload.path.user_id === 'ou_current') return { code: 0, data: { user: { department_ids: ['od_a', 'od_a', 'od_b'] } } }
        return { code: 0, data: { user: { name: '部门负责人' } } }
      } },
      department: { get: async payload => {
        requests.push({ api: 'department.get', payload })
        const name = payload.path.department_id === 'od_a' ? '研发部' : '产品部'
        return { code: 0, data: { department: { name, open_department_id: 'internal-id', member_count: 12, leader_user_id: 'ou_leader', leaders: [{ leaderID: 'ou_leader', leaderType: 1 }] } } }
      } },
    } },
  }
  const departments = await getMyDepartments(client, 'ou_current')
  assert.deepEqual(departments.map(department => department.name), ['研发部', '产品部'])
  assert.equal(departments[0].open_department_id, 'internal-id')
  assert.equal(departments[0].member_count, 12)
  assert.equal(requests.length, 4)
  assert.equal(requests[0].api, 'user.get')
  assert.deepEqual(requests[0].payload.params, { user_id_type: 'open_id', department_id_type: 'open_department_id' })
  assert.equal(requests[1].api, 'department.get')
  assert.deepEqual(requests[1].payload.params, { department_id_type: 'open_department_id', user_id_type: 'open_id' })
  assert.deepEqual(requests[3].payload.path, { user_id: 'ou_leader' })
  assert.deepEqual(departments[0].leaderNames, ['部门负责人'])
})

test('我的部门查询会透传飞书 SDK 的通讯录错误信息', async () => {
  const client = { contact: { v3: { user: { get: async () => ({ code: 41050, msg: 'no user authority error' }) } } } }
  await assert.rejects(
    getMyDepartments(client, 'ou_current'),
    /no user authority error/,
  )
})

test('飞书响应缺少预期对象时会明确报结构异常，而不是静默返回空数据', async () => {
  const client = { contact: { v3: { user: { get: async () => ({ code: 0, data: {} }) } } } }
  await assert.rejects(getMyDepartments(client, 'ou_current'), /飞书响应结构异常/)
})

test('假期余额只从分页结果中返回当前 OAuth 用户对应的记录', async () => {
  const requests = []
  const client = { corehr: { v1: { leave: { leaveBalances: async payload => {
    requests.push(payload)
    const secondPage = payload.params.page_token === 'next-page'
    return { code: 0, data: secondPage
        ? { employment_leave_balance_list: [{ employment_id: 'ou_current', as_of_date: '2026-10-02', leave_balance_list: [] }], has_more: false }
        : { employment_leave_balance_list: [{ employment_id: 'ou_other', leave_balance_list: [] }], has_more: true, page_token: 'next-page' },
    }
  } } } } }
  const result = await getMyLeaveBalances(client, 'ou_current')
  assert.equal(result.employment_id, 'ou_current')
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0].params, { page_size: '100', user_id_type: 'open_id' })
  assert.equal(requests[1].params.page_token, 'next-page')
})

test('假期余额工具输出会移除员工 ID 和其它内部字段', () => {
  const balances = publicLeaveBalances({ leave_balance_list: [{
    leave_type_id: 'leave_internal', leave_type_name: [{ lang: 'zh_cn', value: '年假' }], leave_balance: '5', this_cycle_taken: '3', leave_duration_unit: 1,
  }] })
  assert.deepEqual(balances, [{ leaveType: '年假', balance: '5', taken: '3', unit: '天' }])
})

test('飞书 HTTP Client 暴露插件需要的最小接口', () => {
  const client = createFeishuSdkClient({ appId: 'cli_test', appSecret: 'test-secret' })
  assert.equal(typeof client.contact.v3.user.get, 'function')
  assert.equal(typeof client.contact.v3.department.get, 'function')
  assert.equal(typeof client.corehr.v1.leave.leaveBalances, 'function')
  assert.equal(typeof client.accessToken.retrieveByAuthorizationCode, 'function')
  assert.equal(typeof client.authen.v1.userInfo.get, 'function')
})

test('带取消信号的 HTTP Client 不复用默认 HTTP 实例，避免影响其他 Tool', () => {
  const controller = new AbortController()
  const cachedClient = createFeishuSdkClient({ appId: 'cli_test', appSecret: 'test-secret' })
  const abortableClient = createFeishuSdkClient({ appId: 'cli_test', appSecret: 'test-secret' }, { signal: controller.signal })
  assert.notEqual(abortableClient.httpInstance, cachedClient.httpInstance)
  assert.equal(typeof abortableClient.httpInstance.request, 'function')
  assert.equal(typeof abortableClient.httpInstance.post, 'function')
})

test('运行时只保留 Axios，避免引入 SDK 的 protobufjs 安装脚本', () => {
  assert.deepEqual(packageJson.dependencies, { axios: '1.20.0' })
})

test('假期余额 Skill 通过 ctx.skills 注册，且正文不包含 YAML frontmatter', () => {
  const registrations = []
  const dispose = () => {}
  const ctx = { skills: { register: skill => { registrations.push(skill); return dispose } } }
  assert.equal(registerLeaveBalanceSkill(ctx), dispose)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].name, 'feishu-my-leave-balances')
  assert.equal(registrations[0].source, 'bundled')
  assert.deepEqual(registrations[0].invocation, { modelInvocable: true, userInvocable: true })
  assert.match(registrations[0].content, /feishu_my_leave_balances/)
  assert.doesNotMatch(registrations[0].content, /^---/)
})

test('假期余额排查 Skill 只编排当前用户的余额与脱敏日志工具', () => {
  const registrations = []
  const ctx = { skills: { register: skill => { registrations.push(skill); return () => {} } } }
  registerLeaveBalanceDiagnoseSkill(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].name, 'feishu-leave-balance-diagnose')
  assert.equal(registrations[0].source, 'bundled')
  assert.match(registrations[0].content, /feishu_my_leave_balances/)
  assert.match(registrations[0].content, /feishu_operation_logs/)
  assert.match(registrations[0].content, /不查他人/)
  assert.doesNotMatch(registrations[0].content, /^---/)
})

test('登录指引 Skill 只通过 feishu_login 管理当前 OAuth 登录态', () => {
  const registrations = []
  const ctx = { skills: { register: skill => { registrations.push(skill); return () => {} } } }
  registerLoginGuideSkill(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].name, 'feishu-login-guide')
  assert.equal(registrations[0].source, 'bundled')
  assert.match(registrations[0].content, /status/)
  assert.match(registrations[0].content, /login/)
  assert.match(registrations[0].content, /refresh/)
  assert.match(registrations[0].content, /logout/)
  assert.match(registrations[0].content, /不索取或展示 token/)
})

test('个人信息 Skill 只编排当前授权用户的用户资料 Tool', () => {
  const registrations = []
  const ctx = { skills: { register: skill => { registrations.push(skill); return () => {} } } }
  registerUserInfoSkill(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].name, 'feishu-my-user-info')
  assert.equal(registrations[0].source, 'bundled')
  assert.deepEqual(registrations[0].invocation, { modelInvocable: true, userInvocable: true })
  assert.match(registrations[0].content, /feishu_user_info/)
  assert.match(registrations[0].content, /不查或搜索他人/)
  assert.doesNotMatch(registrations[0].content, /^---/)
})

test('组织信息 Skill 按问题只回答部门或负责人', () => {
  const registrations = []
  const ctx = { skills: { register: skill => { registrations.push(skill); return () => {} } } }
  registerOrganizationSkill(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].name, 'feishu-my-organization')
  assert.equal(registrations[0].source, 'bundled')
  assert.match(registrations[0].content, /feishu_my_departments/)
  assert.match(registrations[0].content, /只问部门则回答/)
  assert.match(registrations[0].content, /只问负责人则回答/)
  assert.match(registrations[0].content, /不展示内部 ID/)
})

test('能力边界 Skill 会拒绝未实现能力，且不包含飞书 API 调用路径', () => {
  const registrations = []
  registerCapabilityBoundarySkill({ skills: { register: skill => { registrations.push(skill); return () => {} } } })
  assert.equal(registrations[0].name, 'feishu-capability-boundary')
  assert.match(registrations[0].content, /不要调用任何飞书 Tool/)
  assert.match(registrations[0].content, /发送消息、审批、打卡/)
  assert.doesNotMatch(registrations[0].content, /open-apis\/|client\./)
})

test('能力清单 Tool 不访问飞书，只返回白名单与拒绝类别', async () => {
  const tools = []
  registerCapabilitiesTool({ tools: { register: tool => tools.push(tool) } })
  const result = await tools[0].execute()
  assert.equal(tools[0].name, 'feishu_capabilities')
  assert.equal(result.supported.some(item => item.tool === 'feishu_my_leave_balances'), true)
  assert.equal(result.unsupportedCategories.includes('发送消息'), true)
})

test('能力 guard 只允许白名单中的飞书 Tool，并最终拒绝未实现调用', () => {
  let guard
  const dispose = () => {}
  assert.equal(registerFeishuCapabilityGuard({ tools: { guard: value => { guard = value; return dispose } } }), dispose)
  assert.equal(guard({ name: 'feishu_my_leave_balances' }), undefined)
  assert.equal(guard({ name: 'unrelated_tool' }), undefined)
  assert.match(guard({ name: 'feishu_send_message' }), /尚未实现/)
})
