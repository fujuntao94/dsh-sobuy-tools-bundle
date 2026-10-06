const SKILL_NAME = 'database-dictionary-lookup'
const SKILL_DESCRIPTION = '查询订单库的字典表：字典目录、指定字典的全部取值，以及编码到中文说明的翻译（含订单原因码 G 码）。'

const SKILL_CONTENT = `# 字典查询

用户问“XX 是什么意思”“G17 是什么”“有哪些平台/国家/销售大区”，或需要把某个编码翻译成中文时，调用 \`database_dictionary_lookup\`。

## 参数

- 一个筛选条件都不传：返回**字典目录**（有哪些字典、各自 \`dict_id\`）。先看清有什么再用。
- \`dict_id\`：返回该字典的全部取值。**原因码字典是 \`dict_id=3\`（Types Of Complaint）**。
- \`dict_value\`：按编码精确查，例如 \`G17\`。这是翻译单个编码最快的方式。
- \`keyword\`：在编码与中文说明里模糊搜，例如“投递”“缺货”。\`%\` 和 \`_\` 按普通字符处理。
- \`include_deprecated\`：默认 \`false\`（只返回 \`valid=1\`）。要翻译历史编码时才设为 \`true\`。

## 字典目录（当前库）

\`1\`=Sales Region、\`2\`=Country、\`3\`=Types Of Complaint（原因码）、\`4\`=Platform、\`5\`=EU Country、\`6\`=Dpd Max Volume、\`7\`=Fedex Max Volume、\`8\`=Ups Max Volume、\`9\`=Dhl Max Volume、\`10\`=非库存SKU。

## 讲原因码时必须说清的两件事

1. **原因码是混合编码，不是全部都能翻译。** 订单操作流水的 \`reason\` 字段里同时存在三类取值：G 码（\`G01\`/\`G17\`/\`G28\`…，**有**字典）、纯数字码（\`34\`/\`38\`/\`40\`/\`50\`…，**没有**字典）、中文码（\`取消订单\`/\`其他原因\`，**没有**字典）。实测整体翻译命中率约 **50.9%**。查不到时如实说“该编码在本库没有对应字典”，**不要按数字顺序去猜含义**。
2. **它是「拦截原因」，不是「订单原因」。** \`reason\` 只在操作类型为「拦截」时才非空。

## 常用原因码

\`G01\`=饰面（油漆）问题、\`G15\`=发货前客户要求取消、\`G17\`=缺货、\`G25\`=预售原因、\`G28\`=其它。完整取值请用 \`dict_id=3\` 查。

## 边界

\`valid=0\` 的项是已失效编码，仍可能出现在历史数据里，所以翻译历史记录时要打开 \`include_deprecated\`。\`enabled=false\`（\`status=0\`）表示未启用，与失效是两回事。不接受任意 SQL，字典值本身也不代表业务口径，涉及统计请用对应的分析类 Tool。`

export function registerDictionarySkill(ctx) {
  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    source: 'bundled',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
