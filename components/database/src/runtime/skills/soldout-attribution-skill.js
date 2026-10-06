const SKILL_NAME = 'database-soldout-attribution'
const SKILL_DESCRIPTION = '分析近 N 天当前待处理或历史订单缺货情况：按 SKU 与仓库或按仓库聚合，并返回主因、并发因素和下一步动作。'

const SKILL_CONTENT = `# 缺货归因

用户询问“缺货原因”“为什么缺货”“哪些 SKU/仓库缺货”“近 N 天缺货情况”时，调用 \`database_soldout_attribution\`。

## 参数

- \`window_days\`：窗口天数，默认 30，上限 45。超过上限会被拒绝，不要尝试绕过。
- \`group_by\`：\`sku\`（默认）返回 SKU 与仓库组合的归因；\`warehouse\` 返回仓库维度分布，不含原因推断。
- \`scope\`：\`active\`（默认）只看当前未发货、未撤单、未取消的缺货状态；\`historical\` 只用于复盘窗口内曾符合缺货口径的订单。
- \`warehouse_id\`：可选，只看某个发货仓库。
- \`top_n\`：返回条数，默认 20，上限 500。

## 原因枚举怎么讲

\`attribution\` 是主因；\`contributingFactors\` 是不能忽略的并发因素；\`primaryAction\` 和 \`recommendedActions\` 是下一步建议。必须按原义表述，不要把推断说成数据库登记的事实。

- \`local_stock_resolved\`：发货仓当前已有可用库存，缺货大多已缓解。
- \`warehouse_allocation_gap\`：发货仓可用为 0 但其他仓有可用量，只能说明存在可调拨库存，不能声称已经有调拨任务卡住。
- \`local_stock_occupied\`：本仓可用为 0 但现货已被占用，需核对占用订单与库存分配。
- \`presale_occupation\`：存在订单预售、预警预售量或库存明细预售占用，指向预售占用可发库存。
- \`container_in_transit\`：关联的预售货柜样本尚无实际到库时间，需跟进到库和入库计划。
- \`shelving_pending\`：存在未完成的预售或现货上架任务，需优先跟进返回的责任人。
- \`warning_unhandled\`：已产生库存预警但预警未标记为已处理，指向处理环节滞后。
- \`genuine_shortage\`：各仓均无可用量，属真实缺货，需要补货。

## 必须说清的三条边界

1. 缺货原因**不是数据库里读出来的字段**，而是用“当前库存、库存明细、库存预警和关联货柜”推断出来的。库里没有缺货原因列，不要把它说成业务系统登记的字段。
2. **时间锚点是订单下单时间**（\`order_time\`），不是断货发生时间。\`active\` 是当前待处理队列；\`historical\` 才能用于历史复盘，仍不能表述为“近 N 天发生的缺货事件”。
3. **库存是当前快照**，不是缺货发生时的库存；货柜只取分组关联的一个样本。\`local_stock_resolved\`、\`genuine_shortage\` 等判定有时效性，应带上 Tool 返回的证据数字。

## 输出与安全

只展示 SKU、仓库、数量和原因，不展示任何客户姓名、地址、电话或邮箱；不接受任意 SQL，也不要引导用户去执行 SQL。引用原因时带上 Tool 返回的 \`attributionNote\` 和依据数字，不要只给结论。

仓库维度（\`group_by=warehouse\`）只能说明缺货集中在哪个仓，不能直接归因；需要原因时改用 \`group_by=sku\` 下钻。`

export function registerSoldoutAttributionSkill(ctx) {
  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    source: 'bundled',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
