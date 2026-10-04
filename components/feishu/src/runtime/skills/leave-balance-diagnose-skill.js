/**
 * 假期余额异常排查 Skill。
 * 只编排已有 Tool，不增加飞书权限，也不突破“当前 OAuth 用户”查询边界。
 */
const SKILL_NAME = 'feishu-leave-balance-diagnose'
const SKILL_DESCRIPTION = '查询并排查当前 OAuth 授权用户的飞书假期余额异常，例如余额为空、权限报错、登录过期或查询失败。'
const SKILL_CONTENT = `# 飞书假期余额排查

先调用 \`feishu_my_leave_balances\`。有结果则简洁展示；空数组仅说明“飞书未返回可展示的余额”，不是零。

仅失败时调用 \`feishu_operation_logs\`：登录问题引导 \`feishu_login\`；权限或租户配置问题请管理员处理；网络或限流提示稍后重试。不要重复查询或猜测余额。

仅限当前 OAuth 用户；不传 ID，不查他人，不展示凭据、ID、原始响应，也不换算单位。`

export function registerLeaveBalanceDiagnoseSkill(ctx) {
  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    source: 'bundled',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
