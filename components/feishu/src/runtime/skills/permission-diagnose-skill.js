const SKILL_CONTENT = `# 飞书权限排查

先执行原需求的 Tool；仅失败时调用 \`feishu_operation_logs\`。\`authentication\` 用 \`feishu_login\`；\`permission\` 请管理员检查权限、可见范围和发布；\`not_found\` 检查当前用户可见范围；\`rate_limited\`、\`network\` 稍后重试；\`invalid_response\` 保留脱敏日志并联系维护者。

仅诊断当前 OAuth 用户，不展示或索取 ID、token、App Secret、授权码或原始响应。`

export function registerPermissionDiagnoseSkill(ctx) {
  return ctx.skills.register({
    name: 'feishu-permission-diagnose',
    description: '排查当前用户飞书工具的权限、登录、限流或接口响应异常。',
    source: 'bundled',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
