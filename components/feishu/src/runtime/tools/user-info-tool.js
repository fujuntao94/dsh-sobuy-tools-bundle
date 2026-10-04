/**
 * 飞书个人信息工具入口。
 * 调用前会确保用户 token 可用；工具输出只包含用户主动授权的资料，不包含任何凭据。
 */
import { getUserInfo } from '../../domains/auth/oauth.js'

function publicUserInfo(user) {
  // 只返回用户需要查看的资料；内部 ID、头像地址和租户标识不进入智能体上下文。
  return Object.fromEntries(Object.entries({
    name: user.name,
    enName: user.en_name,
    email: user.email,
    enterpriseEmail: user.enterprise_email,
    mobile: user.mobile,
  }).filter(([, value]) => value !== undefined && value !== null && value !== ''))
}

export function registerUserInfoTool(ctx, config = {}) {
  ctx.tools.register({
    name: 'feishu_user_info',
    description: '查询当前 OAuth 用户的姓名、邮箱和手机号；token 临近过期时自动刷新，不返回内部 ID 或凭据。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['refreshed', 'user'],
        properties: {
          refreshed: { type: 'boolean' },
          user: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string' }, enName: { type: 'string' }, email: { type: 'string' },
              enterpriseEmail: { type: 'string' }, mobile: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        // render 是智能体可读的文字摘要；与结构化资料保持一致，防止接口
        // 已返回邮箱或手机号但摘要只展示姓名而让调用方误以为没有数据。
        // 企业邮箱优先于个人邮箱，二者都不存在时不伪造字段值。
        text: `当前飞书用户：${value.user.name || '未获取到姓名'}；邮箱：${value.user.enterpriseEmail || value.user.email || '未获取到'}；手机号：${value.user.mobile || '未获取到'}`,
      }],
    },
    async execute(_args, exec) {
      return ctx.feishuTelemetry.run({ tool: 'feishu_user_info', exec }, async () => {
        const active = await ctx.feishuAuth.getActiveUser({ signal: exec.signal })
        // 刷新时已获取过用户信息，避免重复请求；未刷新时再读取一次，保证资料是最新的。
        const user = active.user || await getUserInfo({
          accessToken: active.token.accessToken,
          client: await ctx.feishuAuth.getSdkClient({ signal: exec.signal }),
        })
        return { refreshed: active.refreshed, user: publicUserInfo(user) }
      }, value => ({ refreshed: value.refreshed, hasName: Boolean(value.user.name), hasEmail: Boolean(value.user.email) }))
    },
  })
}
