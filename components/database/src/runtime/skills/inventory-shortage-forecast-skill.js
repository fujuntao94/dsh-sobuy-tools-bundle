const SKILL_NAME = 'database-inventory-shortage-forecast'
const SKILL_DESCRIPTION = '按当前月预测销量和当前库存预警即将断货的 SKU×仓库，说明库存覆盖、缺口和候选调拨库存；不分析已发生缺货。'

const SKILL_CONTENT = `# 预测性缺货预警

用户询问“哪些 SKU 快断货”“库存还能覆盖几天”或“按预测销量预警”时，调用 \`database_inventory_shortage_forecast\`。它按当前自然月的预测销量和当前库存，返回覆盖天数低于阈值的 SKU×仓库；不用于解释已经缺货的订单。

## 参数

- \`coverage_days\`：库存覆盖阈值，默认 14，范围 1–90。
- \`warehouse_id\`：可选，只看指定仓库。
- \`top_n\`：返回条数，默认 500，范围 1–1000。

## 输出要求

使用 Tool 返回的结构化字段，不要自行补算或猜测数据：

1. 先输出 \`forecastMonth\`、\`coverageThresholdDays\`、\`groups\` 和 \`summary.byRisk\`。
2. 每项输出 SKU、仓库、风险等级、预测月/日销量、本仓可用库存、覆盖天数、缺口、候选调拨库存、责任人、库存更新时间和建议动作。
3. \`groups=0\` 时说明“当前没有库存覆盖低于 N 天的 SKU×仓库分组”，不要说成没有预测数据或绝不会缺货。

候选调拨库存不是已创建的调拨，也不是到货承诺；责任人只是跟进线索。

## 边界

覆盖天数是“当前可用库存 ÷ 当前月预测日均销量”的估算，不是采购、到货或履约承诺。已经缺货的订单原因改用 \`database_soldout_attribution\`；不接受任意 SQL。`

export function registerInventoryShortageForecastSkill(ctx) {
  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    source: 'bundled',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
