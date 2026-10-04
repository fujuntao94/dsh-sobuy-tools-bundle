const SKILL_CONTENT = `# 飞书能力边界

只使用已注册 Tool：登录、本人资料、本人部门、本人假期余额和 \`feishu_capabilities\`。

对发送消息、审批、打卡、日历、群、文档、表格、请假申请及其他未登记能力：直接说明“当前插件尚未实现「功能名」”，不要调用任何飞书 Tool；需要时调用 \`feishu_capabilities\`。

不得根据 SDK、URL 或已有 Tool 绕过边界，不索取 token、App Secret、授权码或 ID，也不要把未实现误称为权限不足。`

export function registerCapabilityBoundarySkill(ctx) {
  return ctx.skills.register({
    name: 'feishu-capability-boundary',
    description: '限定飞书插件只调用已实现能力；未实现需求直接说明不支持且不访问飞书。',
    source: 'bundled', content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
