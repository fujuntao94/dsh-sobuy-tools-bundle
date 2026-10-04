import { publicCapabilities } from '../capabilities/feishu-capabilities.js'

// 把白名单从能力清单生成，避免 Tool 新增后出现“Skill 说支持、运行时拒绝”两套事实。
const allowedToolNames = new Set(publicCapabilities().map(capability => capability.tool))

/**
 * 运行时硬拒绝：Skill 只是在模型层解释规则；guard 才是不可被后续策略放行的边界。
 *
 * 仅检查 feishu_ 前缀，避免干扰 DSH 自带或其它插件的 Tool。
 * 返回字符串代表拒绝原因；返回 undefined 代表继续执行。
 */
export function registerFeishuCapabilityGuard(ctx) {
  return ctx.tools.guard(exec => {
    const name = exec?.name
    if (typeof name !== 'string' || !name.startsWith('feishu_')) return undefined
    if (allowedToolNames.has(name)) return undefined
    return `飞书功能「${name}」尚未实现，已被插件能力白名单拒绝。可调用 feishu_capabilities 查看当前支持范围。`
  })
}
