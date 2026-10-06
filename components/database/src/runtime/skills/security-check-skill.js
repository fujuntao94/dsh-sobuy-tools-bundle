const SKILL_CONTENT = `# 数据库安全检查

用户询问数据库账号是否只读、查询限制或数据库安全策略时，调用无参数的 \`database_security_check\`。

\`read_only\` 才表示授权清单已确认只读；\`writable\` 必须明确提示账号具有写入能力；\`unknown\` 表示存在角色或其他需人工确认的权限，不能说成安全。

只展示账号状态、最大返回行数、查询超时和安全开关，不展示凭据、原始授权语句、SQL、参数、查询结果或驱动错误。`

export function registerSecurityCheckSkill(ctx) {
  return ctx.skills.register({
    name: 'database-security-check',
    description: '检查数据库账号只读状态以及行数、超时、敏感字段和脱敏日志等查询安全策略。',
    source: 'bundled',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
