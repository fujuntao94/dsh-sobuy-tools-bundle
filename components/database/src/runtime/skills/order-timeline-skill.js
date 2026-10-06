const SKILL_NAME = 'database-order-timeline'
const SKILL_DESCRIPTION = '按订单号返回单个订单的完整操作流水（改单轨迹），含操作类型、原因码翻译、说明与操作人。'

const SKILL_CONTENT = `# 订单事件时间线

用户问“这笔订单发生了什么”“为什么被拦截”“谁改的”“订单轨迹”，或需要排查单笔订单异常时，调用 \`database_order_timeline\`。

## 参数

- \`order_id\`：必填，订单号，最长 64 字符。
- \`limit\`：返回最近多少条，默认 50，上限 200。单笔订单流水均值 10.9 条，但**极值可超过 10 万条**，所以必须受限。

## 怎么读结果

- 按操作时间**倒序**返回，第 1 条是最新的。
- \`operation\` 是操作类型，当前库共 86 种，常见的有：发布、发布中、获取面单成功/失败、仓库已打单、仓库已装车、提交仓库发货、拦截、新增客诉、新增售后、售后-确认退款、修改SKU、修改快递、已断货、投递异常。
- \`totalRecords\` 是该订单流水总条数；\`mayBeTruncated\` 为 true 时说明只显示了最近一部分，需要更多就调大 \`limit\`。
- \`information\` 是机器生成的状态说明，主要是“发布成功”“面单号:xxx”“回传中”和承运商报错原文，**最多 300 字符**。带面单号的记录可用于找承运商问题。

## 三条必须说清的边界

1. **原因码只在「拦截」类操作上才有值。** \`reason\` 有值的 4.79 万条里，几乎全部是「拦截」（另有极少量「异常打单-自动拦截」）。所以它**不是订单的通用原因字段**，不要把某个原因码说成“这笔订单的原因”。
2. **原因码翻译不保证成功。** \`reasonTranslated=false\` 时说明该编码在本库没有字典（原因码是混合编码，只有 G 码有字典），此时**原样引用编码，不要臆测含义**。可用 \`database_dictionary_lookup\`（\`dict_id=3\`）进一步确认。
3. **这里没有客户资料。** 该表有客户相关字段，但本 Tool 只返回操作类型、原因码、状态说明、操作人和时间；人工填写的解释字段（\`action_explain\`）**不返回**。因此查不到“客户投诉的具体内容”，需要那类信息请走客诉/售后相关的数据源。

## 与缺货归因的分工

\`database_soldout_attribution\` 回答“哪些 SKU/仓库缺货、原因是什么”（聚合视角）；本 Tool 回答“**这一笔**订单经历了什么”（单笔视角）。做单笔复盘时先用本 Tool 拿轨迹，再按需补归因。`

export function registerOrderTimelineSkill(ctx) {
  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    source: 'bundled',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
