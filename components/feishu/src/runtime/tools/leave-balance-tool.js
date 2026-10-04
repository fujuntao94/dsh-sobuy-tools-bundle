/** 当前 OAuth 用户的假期余额工具入口。 */
import { getMyLeaveBalances } from "../../domains/leave/leave-balance-api.js";

function displayName(values) {
  if (!Array.isArray(values)) return undefined;
  return (
    values.find((item) => item.lang === "zh_cn")?.value ||
    values.find((item) => item.lang === "en_us")?.value ||
    values[0]?.value
  );
}

function durationUnit(value) {
  // 飞书接口的枚举值可能随人事版本扩展，保留原值以免把未知单位误展示成天。
  return { 1: "天", 2: "小时" }[value] || undefined;
}

/** 仅将当前用户可见的余额字段交给智能体。 */
export function publicLeaveBalances(record) {
  return (record?.leave_balance_list || []).map((balance) => ({
    leaveType: displayName(balance.leave_type_name) || "未命名假期",
    balance: balance.leave_balance,
    taken: balance.this_cycle_taken ?? balance.taken,
    unit: durationUnit(balance.leave_duration_unit),
  }));
}

export function registerLeaveBalanceTool(ctx, config = {}) {
  ctx.tools.register({
    name: "feishu_my_leave_balances",
    description:
      "查询当前 OAuth 用户的假期余额。无需也不能传入用户 ID、员工 ID 或部门；不返回内部标识或他人数据。",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["refreshed", "balances"],
        properties: {
          refreshed: { type: "boolean" },
          asOfDate: { type: "string" },
          balances: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["leaveType"],
              properties: {
                leaveType: { type: "string" },
                balance: { type: "string" },
                taken: { type: "string" },
                unit: { type: "string" },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `${value.refreshed ? "已自动刷新登录状态；" : ""}我的假期余额：${value.balances.length ? value.balances.map((item) => `${item.leaveType} ${item.balance ?? "未提供"}`).join("；") : "未找到可用余额"}`,
        },
      ],
    },
    async execute(_args, exec) {
      return ctx.feishuTelemetry.run(
        { tool: "feishu_my_leave_balances", exec },
        async () => {
          // 先确认当前 OAuth 登录态；未登录或刷新失败时不应继续获取应用 token。
          const { active, openId } = await ctx.feishuAuth.getCurrentOpenId({
            signal: exec.signal,
          });
          const client = await ctx.feishuAuth.getSdkClient({ signal: exec.signal });
          const record = await getMyLeaveBalances(client, openId);
          return {
            refreshed: active.refreshed,
            ...(record?.as_of_date ? { asOfDate: record.as_of_date } : {}),
            balances: publicLeaveBalances(record),
          };
        },
        (value) => ({
          refreshed: value.refreshed,
          balanceTypeCount: value.balances.length,
          hasAsOfDate: Boolean(value.asOfDate),
        }),
      );
    },
  });
}
