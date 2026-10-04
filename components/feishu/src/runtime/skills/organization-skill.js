/** 当前 OAuth 用户的部门与负责人问答路由 Skill。 */
const SKILL_NAME = 'feishu-my-organization'
const SKILL_DESCRIPTION = '回答当前 OAuth 授权用户属于哪个部门、部门负责人是谁等组织信息问题。'
const SKILL_CONTENT = `# 飞书我的组织信息

询问本人部门或负责人时，调用无参数的 \`feishu_my_departments\`。只问部门则回答 \`name\`；只问负责人则回答 \`leaderNames\`；同时问则两者都答。空数组或空负责人只说明飞书未返回可展示信息。

仅限当前 OAuth 用户：不传 ID，不查他人，不猜测组织关系，也不展示内部 ID、凭据或原始响应。`

export function registerOrganizationSkill(ctx) {
  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    source: 'bundled',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
