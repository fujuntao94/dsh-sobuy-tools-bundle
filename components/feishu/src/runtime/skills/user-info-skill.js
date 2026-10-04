/** 当前 OAuth 授权用户的个人资料问答路由 Skill。 */
const SKILL_NAME = 'feishu-my-user-info'
const SKILL_DESCRIPTION = '查询当前 OAuth 授权用户自己的飞书姓名、邮箱和手机号；不用于查询其他人。'

const SKILL_CONTENT = `# 飞书我的个人信息

询问本人资料、邮箱、手机号或“我是谁”时，调用无参数的 \`feishu_user_info\`。只问一个字段只回答该字段；完整资料简洁列出姓名、邮箱（企业邮箱优先）和手机号。缺失字段只说明飞书未返回；未登录引导 \`feishu_login\`。

只使用 Tool 返回字段，只查当前 OAuth 用户：不传 ID，不查或搜索他人，不展示内部 ID、头像、凭据或原始响应，也不将资料用于未实现功能。`

export function registerUserInfoSkill(ctx) {
  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    source: 'bundled',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
