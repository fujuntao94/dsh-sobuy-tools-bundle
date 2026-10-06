export function createSecurityCheckTool({ securityService }) {
  return {
    name: 'database_security_check',
    description: '检查当前数据库账号是否可确认只读，并返回行数上限、超时、敏感字段屏蔽和日志脱敏策略。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['account', 'policy'],
        properties: {
          account: {
            type: 'object', additionalProperties: false,
            required: ['status', 'readOnlyVerified', 'writePrivileges', 'reviewPrivileges', 'reason'],
            properties: {
              status: { type: 'string', enum: ['read_only', 'writable', 'unknown'] },
              readOnlyVerified: { type: 'boolean' },
              writePrivileges: { type: 'array', items: { type: 'string' } },
              reviewPrivileges: { type: 'array', items: { type: 'string' } },
              reason: { type: 'string' },
            },
          },
          policy: {
            type: 'object', additionalProperties: true,
            properties: {
              maxRows: { type: 'number' },
              queryTimeoutMs: { type: 'number' },
              sensitiveFields: { type: 'array', items: { type: 'string' } },
              arbitrarySqlAllowed: { type: 'boolean' },
              multipleStatementsAllowed: { type: 'boolean' },
              writeStatementsAllowed: { type: 'boolean' },
              queryLogsRedacted: { type: 'boolean' },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `账号状态：${value.account.status}`,
          value.account.reason,
          '业务表访问：不设白名单；仅现有只读工具的固定查询或结构化 SELECT 可访问。',
          `最大返回行数：${value.policy.maxRows}`,
          `查询超时：${value.policy.queryTimeoutMs}ms`,
          '任意 SQL：禁止；多语句：禁止；写入语句：禁止；查询日志：脱敏。',
        ].join('\n'),
      }],
    },
    async execute(_args, exec) {
      try {
        const [account, policy] = await Promise.all([
          securityService.checkReadonly({ signal: exec?.signal }),
          securityService.policy(),
        ])
        return { account, policy }
      } catch (error) {
        if (exec?.signal?.aborted) throw new Error('数据库安全检查已取消。')
        throw new Error('无法完成数据库安全检查，请检查连接信息、网络和账号权限。')
      }
    },
  }
}

export function registerSecurityCheckTool(ctx, options) {
  return ctx.tools.register(createSecurityCheckTool(options))
}
