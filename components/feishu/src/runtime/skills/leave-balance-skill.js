/**
 * 将内置的 Skill 正文作为运行时 Skill 注册到 DSH。
 * Skill 不依赖文件系统扫描，也不会作为独立 Skill 包重复发现。
 */

const SKILL_NAME = 'feishu-my-leave-balances'
const SKILL_DESCRIPTION = '查询当前 OAuth 授权用户自己的飞书假期余额。适用于年假、调休、病假等个人余额查询；不用于查询他人、部门或全公司余额。'
const SKILL_CONTENT = `# 飞书我的假期余额

用户询问本人年假、调休、病假等余额时，调用无参数的 \`feishu_my_leave_balances\`。

仅展示返回的类型、余额、已用额度、单位和统计日期；空数组表示未返回可展示余额，不是零。未登录引导 \`feishu_login\`；权限或租户配置问题请管理员处理。

只查当前 OAuth 用户：不传 ID，不查他人，不换算单位，不展示内部 ID、凭据或原始响应。`

export function registerLeaveBalanceSkill(ctx) {
  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    // Runtime SkillRegistration 的 source 是必填字符串；bundled 表示随当前插件内置。
    source: 'bundled',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
