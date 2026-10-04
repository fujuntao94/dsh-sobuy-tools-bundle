import { publicCapabilities, UNSUPPORTED_CATEGORIES } from '../capabilities/feishu-capabilities.js'

/**
 * 这是说明型 Tool，不访问飞书、不读取 token。
 * 作用是让模型在不确定能力范围时先读取准确白名单，而不是猜测 SDK 能力。
 */
export function registerCapabilitiesTool(ctx) {
  ctx.tools.register({
    name: 'feishu_capabilities',
    description: '查看本插件支持范围；不访问飞书或登录状态。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['supported', 'unsupportedCategories'],
        properties: {
          supported: { type: 'array', items: { type: 'object', additionalProperties: true } },
          unsupportedCategories: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `当前支持：${value.supported.map(item => item.name).join('、')}。暂不支持：${value.unsupportedCategories.join('、')}。` }],
    },
    async execute() {
      return { supported: publicCapabilities(), unsupportedCategories: [...UNSUPPORTED_CATEGORIES] }
    },
  })
}
