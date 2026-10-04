/** 飞书 OAuth 登录与恢复指引 Skill。 */
const SKILL_NAME = 'feishu-login-guide'
const SKILL_DESCRIPTION = '检查、发起、刷新或退出当前本机飞书 OAuth 登录，适用于“登录飞书”“授权过期”“重新登录”等问题。'
const SKILL_CONTENT = `# 飞书登录

使用 \`feishu_login\`：意图不明确先 \`status\`；未配置时引导用户到“设置 → 插件 → 飞书工具”填写凭据；已配置未登录用 \`login\`；过期用 \`refresh\`，失败再 \`login\`；明确退出用 \`logout\`。

只管理当前本机 OAuth 状态，不索取或展示 token、App Secret、授权码、ID 或回调内容；登录成功后无需额外验证。`

export function registerLoginGuideSkill(ctx) {
  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    source: 'bundled',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
