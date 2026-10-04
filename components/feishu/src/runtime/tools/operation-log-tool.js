/** 查询当前 DSH 会话中本插件的脱敏操作摘要。 */
export function registerOperationLogTool(ctx) {
  ctx.tools.register({
    name: 'feishu_operation_logs',
    description: '查看当前会话的飞书脱敏操作摘要，用于排查失败；不返回凭据、ID 或原始响应。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['operations'],
        properties: {
          summary: { type: 'object', additionalProperties: true },
          operations: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['operationId', 'tool', 'status', 'startedAt', 'durationMs'],
              properties: {
                operationId: { type: 'string' }, tool: { type: 'string' }, status: { type: 'string', enum: ['success', 'error'] },
                startedAt: { type: 'number' }, durationMs: { type: 'number' }, summary: { type: 'object', additionalProperties: true },
                // 错误记录会由 Telemetry 补充这三个脱敏诊断字段；必须同步声明，
                // 否则 DSH 的严格 output schema 会在渲染前拒绝返回结果。
                errorKind: { type: 'string' }, errorCode: { type: 'string' }, errorStatus: { type: 'number' }, error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.operations.length
          ? `当前会话最近 ${value.operations.length} 条飞书操作：${value.operations.map(item => `${item.tool} ${item.status === 'success' ? '成功' : '失败'}（${item.durationMs}ms）`).join('；')}`
          : '当前会话尚无飞书工具操作记录。',
      }],
    },
    async execute(_args, exec) {
      // sessionId 仅用于服务内部隔离，诊断输出不暴露会话内部标识。
      const operations = ctx.feishuTelemetry.recent(exec).map(({ sessionId: _sessionId, callId: _callId, ...record }) => record)
      return { operations, summary: ctx.feishuTelemetry.summary(exec) }
    },
  })
}
