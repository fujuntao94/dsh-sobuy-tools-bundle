const SKILL_NAME = 'database-soldout-attribution'
const SKILL_DESCRIPTION = '分析已经缺货的订单：按 SKU 与仓库或按仓库聚合，返回主因、并发因素、完整证据、恢复依据、影响优先级和下一步动作。预测性缺货转用专用 Tool。'

const SKILL_CONTENT = `# 缺货归因

用户询问“缺货原因”“为什么缺货”“哪些 SKU/仓库已经缺货”“当前缺货待办”“近 N 天缺货复盘”时，调用 \`database_soldout_attribution\`。

用户问“哪些 SKU 还没缺货但快断货”“预测缺货”“库存还能覆盖几天”“按预测销量预警”时，改调用 \`database_inventory_shortage_forecast\`，不要把预测风险混入本 Tool 的已缺货归因结论。

不要为了确认表名、字段或归因逻辑调用宿主的文件搜索/\`grep\`；归因 Tool 已内置固定只读查询模板。若 Tool 返回配置错误，只说明具体配置项并引导重试，不要改用文件搜索。

## 参数

- \`window_days\`：仅 \`historical\` 使用的窗口天数，默认 30，上限 45。\`active\` 会忽略它并查询全部当前待处理订单；超过上限时不要尝试绕过，应改用缺货快照趋势。
- \`group_by\`：\`sku\`（默认）返回 SKU 与仓库组合的归因；\`warehouse\` 返回仓库维度分布，不含原因推断。
- \`scope\`：\`active\`（默认）查全部当前未发货、未撤单、未取消的缺货状态，不限制下单时间；\`historical\` 只用于复盘窗口内曾符合缺货口径的订单。
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

## 结果怎么读

每条 SKU×仓库会返回扁平字段，同时有 \`evidence\` 分组，便于直接复核结论：

- \`evidence.shortage\`：最早/最近缺货时间、按状态拆分的缺货行、涉及下单日、强制发货超时数与最早强制发货时间。
- \`evidence.inventory\`：本仓可用、现货/预售占用、库存更新时间、其他仓可用量和候选调拨仓。
- \`evidence.warning\`：是否存在预警、预售量、临界值、处理标记与预警时间。
- \`evidence.container\`：关联货柜样本、关联货柜数、预计/实际到库、预售截止、状态和装柜量。
- \`evidence.shelving\`：未完成上架任务数、责任人与最早任务创建时间。

应先引用 \`attributionNote\` 和上述证据，再给出 \`primaryAction\`；\`recoveryEta\` 只在关联在途货柜存在预计到库时才有值，不得改写成到货承诺。

## 业务优先级与恢复线索

- \`impactLevel\` / \`impactNote\` 根据强制发货是否超时、等待时长、订单数和数量给出影响分级；不是金额优先级，不能自行加总跨币种金额。
- \`recoveryStatus\` / \`recoveryBasis\` / \`recoveryEta\` 只说明当前库存、关联货柜或上架任务提供的恢复线索。只有关联货柜的预计到库时间可以作为 ETA，不能承诺恢复或到货。
- \`shortageDays\` 表示窗口内有缺货订单的不同下单日期数量；\`shortageTrend\` 的“新近/反复/持续”不是严格连续断货天数。
- \`responsibleOwners\` 是未完成上架任务的去重责任人，仅是待办跟进线索；不要把责任人断言为缺货责任主体。

## 必须说清的三条边界

1. 缺货原因**不是数据库里读出来的字段**，而是用“当前库存、库存明细、库存预警、关联货柜和上架任务”推断出来的。库里没有缺货原因列，不要把它说成业务系统登记的字段。
2. **时间锚点是订单下单时间**（\`order_time\`），不是断货发生时间。\`active\` 是全量当前待处理队列，不受下单时间限制；\`historical\` 才按 \`order_time\` 做历史复盘，仍不能表述为“近 N 天发生的缺货事件”。
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
