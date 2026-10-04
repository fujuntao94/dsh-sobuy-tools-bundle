/**
 * DSH 原生 Hook：观察飞书 Tool 的最终结果。
 *
 * tools/result 是 emit 型事件，不能改变 Tool 的结果；适合补充诊断审计，
 * 也避免错误使用 pre-execute / post-execute waterfall 而影响全部 Tool 调用。
 */
const OBSERVED_TOOLS = new Set([
  'feishu_login',
  'feishu_user_info',
  'feishu_my_departments',
  'feishu_my_leave_balances',
])

export function registerFeishuToolHooks(ctx) {
  return ctx.on('tools/result', (exec, result) => {
    if (!OBSERVED_TOOLS.has(exec.name)) return
    ctx.feishuTelemetry.captureFinalResult(exec, result)
  })
}
