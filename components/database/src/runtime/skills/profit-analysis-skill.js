const content = `# 经营利润分析

所有利润工具都必须提供付款月份 \`month\`（YYYY-MM），只读且不接受 SQL。

- 实际利润、利润率、费用构成：\`database_profit_analysis\`。
- 目标达成、目标缺口：\`database_profit_target_attainment\`。
- SKU 实际与预测销量差异：\`database_profit_forecast_variance\`；可传 \`forecast_source=original\` 或 \`adjusted\`，两种预测绝不自动相加。
- 净利润月环比：\`database_profit_attribution\`。它是会计字段差额，不是价格、销量或广告的因果结论。
- SKU 盈利四象限：\`database_profit_sku_matrix\`。阈值来自本次返回集，受 \`top_n\` 限制。

净利润、毛利润和销售额直接采用事实表的已沉淀字段。费用分摊只能解释构成，不能再次从净利润扣减。实际按付款日期统计，不等同于开票或发货日期；不返回客户资料。`

export function registerProfitAnalysisSkill(ctx) {
  return ctx.skills.register({
    name: 'database-profit-analysis',
    description: '查询实际利润、目标达成、预测偏差、利润环比与 SKU 盈利矩阵。',
    source: 'bundled',
    content,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
