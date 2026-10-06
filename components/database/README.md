# Sobuy 数据查询组件

这是 `dsh-sobuy-tools-bundle` 中独立启停的数据库组件。

当前提供与飞书组件一致的订单数据库设置入口流程：

1. 在 Desktop 插件页打开“数据库设置页”。
2. 浏览器访问 `http://127.0.0.1:18082/database/setup`。
3. 填写订单数据库的 MySQL 主机、端口、数据库名、只读用户名、密码和 SSL 选项并保存。
4. 页面从脱敏状态接口恢复非敏感字段；已保存密码不会回显，留空表示不修改。

配置默认保存到 `~/.dsh/database-tools/config.json`，目录权限为 `0700`，文件权限为 `0600`。数据库配置不复用飞书组件的配置或 OAuth 登录态。

组件注册以下只读能力：

- Tool：`database_list_tables`，只查询订单数据库的 `information_schema.tables`，统计基础表并读取 `TABLE_COMMENT`。
- Tool：`database_describe_table`，只查询订单数据库的 `information_schema.columns`，返回指定表的字段名、类型、是否可空、键标记与字段备注。
- Tool：`database_soldout_attribution`，全部当前待处理缺货归因或近 N 天历史复盘，见下方专节。
- Tool：`database_inventory_shortage_forecast`，按当前月预测销量和当前库存发现尚未缺货但即将断货的 SKU×仓库，见下方专节。
- Tool：`database_dictionary_lookup`，字典目录 / 字典取值 / 编码翻译，含订单原因码（G 码），见下方专节。
- Tool：`database_order_timeline`，按订单号返回单笔订单的完整操作流水，见下方专节。
- Skill：`database-table-catalog`，回答表数量，并只列出表名和用途。
- Skill：`database-soldout-attribution`，解释缺货归因的口径、原因枚举与使用边界。
- Skill：`database-dictionary-lookup`，解释字典目录，以及原因码是混合编码这一事实。
- Skill：`database-order-timeline`，解释流水字段含义、原因码只属于「拦截」操作，以及不返回客户资料。

没有填写表备注时，用途固定返回“未填写表备注”，不会根据表名猜测。表结构查看只读元数据，不返回默认值或任何业务记录，也不接受任意 SQL。设置页中的“已保存”只代表配置落盘，不代表连通性验证通过。

## 改这个组件的工具 schema 前必读

宿主的 `tools.register()` 会对 `output.schema` 强制校验，不合规就抛 `JsonSchemaError`；
该异常发生在**组件激活阶段**，所以一个字段写错会让本组件全部工具一起「启用失败」。
已发生过一次：`filters` 里的 `type: ['number', 'null']`（联合类型数组不被支持）。

- 可空字段用 `nullableSchema(type, description)`（来自 `sobuy-plugin-core/schema`），
  等价于 `oneOf: [{ type: 'x' }, { type: 'null' }]`；不要用类型数组。
- 输出 schema 的关键字白名单：`type` / `oneOf` / `properties` / `required`
  / `additionalProperties` / `items` / `enum` / `const` + 注解 `description` / `title`
  / `default` / `examples`。`minimum`、`maxLength` 只能写在工具参数里。
- 输出值在运行时同样按 `output.schema` 校验，所以“可空却声明成单类型”即使注册通过，
  运行到那一步仍会失败。
- 改动后跑 `npm test`（含 `test/tool-schema.test.js`）与 `npm run check:host-schema`。

## 缺货归因（`database_soldout_attribution`）

SQL 是代码内固定的聚合模板，模型只能选聚合维度和填参数，接触不到 SQL 字符串或表名。

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `window_days` | 1–45，默认 30 | 仅 `historical` 使用：窗口天数，**按订单下单时间筛选**；`active` 忽略此参数 |
| `group_by` | `sku`（默认）/ `warehouse` | `sku` 返回 SKU×仓库的归因；`warehouse` 只返回仓库维度分布 |
| `scope` | `active`（默认）/ `historical` | `active` 查全部未发货、未撤单、未取消的当前缺货队列，不限制下单时间；`historical` 用于复盘窗口内曾符合缺货口径的订单 |
| `warehouse_id` | 可选整数 | 单仓下钻 |
| `top_n` | 1–500，默认 20 | 按缺货行数倒序取前 N |

归因数据源与用途：

- `oms_t_orders_tracking`：缺货行（`soldout_time` 非空，或状态为 `3D|3D` 已断货、`1A|06` 订单缺货处理、`1A|04` 库存不足、`1A|2C` 预售），且必须 `valid = 1`。
- `oms_t_inventory`、`oms_t_inventory_detail`：比对发货仓与其他仓的**当前**可用库存、现货占用和明细预售占用。
- `early_warn_inventory_info`：按 SKU×仓库匹配**最新有效**库存预警的预售量、临界值与处理状态（`is_delete = 0`）。
- `bas_t_container`、`bas_t_container_sku`：用订单关联货柜样本补充预售货柜的预计/实际到库状态。
- `bas_t_work_stock`：匹配未完成的预售/现货上架任务、责任人及最早任务创建时间。

`attribution` 是对上述证据的主因推断；`contributingFactors` 保留并发因素；`primaryAction` 和 `recommendedActions` 提供下一步动作。它们均不是数据库中的原因字段。

| 取值 | 判定 |
| --- | --- |
| `local_stock_resolved` | 发货仓当前已有可用库存，缺货多已缓解 |
| `warehouse_allocation_gap` | 发货仓可用为 0、其他仓有可用量，表示存在候选调拨库存，不代表已有调拨任务卡住 |
| `local_stock_occupied` | 本仓可用为 0、但存在现货占用 |
| `presale_occupation` | 存在订单预售、预警预售量或库存明细预售占用 |
| `container_in_transit` | 关联预售货柜样本尚无实际到库时间 |
| `shelving_pending` | 存在未完成的预售或现货上架任务 |
| `warning_unhandled` | 有库存预警且未标记为已处理 |
| `genuine_shortage` | 各仓均无可用量，真实缺货 |

两条必须知道的口径限制：

- 时间锚点是 `order_time` 而不是 `soldout_time`：`soldout_time` 无索引（表约 273 万行），且 `1A|06`、`1A|04` 这类状态的 `soldout_time` 为空，用它做窗口会漏掉整个“缺货处理中”队列。`active` 不使用时间窗口，以免漏掉长期未解决订单；`historical` 才按 `order_time` 限制窗口。
- 库存是**当前快照**，不是缺货发生时的库存；货柜只取分组关联样本，相关判定有时效性。
- `historical` 窗口上限 45 天：实测 7 天约 0.6s、30 天约 0.7s、45 天约 1.0s，但 60 天会跳到 13.9s 并撞上查询超时。更久趋势应使用缺货快照对比，而不是无限扫描订单历史明细。

固定归因查询不依赖业务表白名单，且不接受表名或 SQL 参数。MySQL 会先按 SKU×仓库聚合当前缺货订单，再关联已按相同维度聚合的库存明细、上架任务等证据；Tool 端只接收最终聚合结果，不拉取订单明细，也不含客户姓名、地址、电话或邮箱。

SKU 维度结果按 P0–P3 待办优先级排序，并附带本次返回范围内按主因、仓库、责任人、影响等级和缺货趋势的汇总。每条 SKU×仓库还会返回：

- `impactLevel` / `impactNote`：由强制发货是否超时、等待时长及受影响订单/数量推断的影响等级；它不是订单金额优先级，也没有跨币种金额加总。
- `recoveryStatus` / `recoveryBasis` / `recoveryEta`：当前库存、关联在途货柜或上架任务提供的恢复线索；只有货柜预计到库时间会作为 ETA，不能据此承诺恢复结果。
- `shortageDays` / `shortageTrend`：窗口内有缺货订单的不同下单日期数量及“新近/反复/持续”分组；它不是严格连续断货天数。
- `evidence`：按 `shortage`、`inventory`、`warning`、`container`、`shelving` 五组完整返回判定依据；顶层原有字段继续保留兼容性。

`historical` 口径还会通过 `currentState` 标示该分组当前是 `active`、`recovered_or_closed` 还是 `mixed`。

## 预测性缺货预警（`database_inventory_shortage_forecast`）

这个 Tool 只回答“**还未缺货，但按当前月预测销量可能即将断货**”，不会扫描订单明细，也不代替订单缺货归因。

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `coverage_days` | 1–90，默认 14 | 只返回当前库存覆盖天数低于该阈值的 SKU×仓库 |
| `warehouse_id` | 可选整数 | 只预警指定仓库 |
| `top_n` | 1–500，默认 20 | 返回条数上限 |

固定读取 `report_t_predict_sku` 当前自然月预测销量与责任人、`oms_t_inventory` 当前库存。MySQL 内部先按 SKU×仓库聚合预测和库存，再按覆盖天数过滤；返回月预测量、预测日均量、本仓可用/占用、库存更新时间、覆盖天数、达到阈值仍需补足的数量、其他仓候选库存、预测责任人和建议动作。

覆盖天数只是“当前库存 ÷ 当前月预测日均销量”的估算，不代表采购到货承诺；其他仓库存也只表示候选调拨量。

## 缺货快照

- `database_soldout_snapshot_capture`：从 OMS 只读采集当前待处理缺货队列的前 500 个 SKU×仓库分组，保存在插件私有目录；同一天重复采集会覆盖当天快照，不写 OMS 数据表。
- `database_soldout_snapshot_compare`：比较最近两份私有快照，返回新增、已解决、持续与缺货量恶化的分组数量。

## 字典查询（`database_dictionary_lookup`）

同样使用代码内固定模板。不传任何筛选条件时返回**字典目录**（`bas_t_dict`，当前 10 个字典）；传条件时返回字典取值（`bas_t_dict_values`）。

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `dict_id` | 可选整数 | 字典 ID。**原因码字典是 `3`（Types Of Complaint）** |
| `dict_value` | 可选，≤50 字符 | 编码精确匹配，例如 `G17` |
| `keyword` | 可选，≤50 字符 | 在编码与中文说明里模糊搜；`%`、`_` 会被转义成普通字符 |
| `include_deprecated` | 布尔，默认 `false` | 是否包含 `valid=0` 的已失效项 |

固定读取表：`bas_t_dict`、`bas_t_dict_values`。

**原因码是混合编码**——订单操作流水的 `reason` 字段混合了三类取值，只有 G 码有字典：

| 形态 | 行数 | 种数 | 有字典 |
| --- | --- | --- | --- |
| G 码（`G01`/`G17`/`G28`…） | 24,375 | 33 | 有 |
| 纯数字码（`34`/`38`/`40`/`50`…） | 21,295 | 31 | **没有** |
| 中文码（`取消订单`/`其他原因`…） | 2,231 | 8 | **没有** |

实测整体翻译命中率约 **50.9%**。数字码与中文码在**全库任何字典中都不存在**，翻译不到时应原样引用编码，不得按数字顺序臆测含义。

## 订单事件时间线（`database_order_timeline`）

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `order_id` | 必填，≤64 字符 | 订单号 |
| `limit` | 1–200，默认 50 | 返回最近多少条 |

依赖表：`oms_t_order_action`（约 2196 万行）、`bas_t_dict_values`。原因码通过 `dict_id=3` 的派生表 `LEFT JOIN` 翻译；先用 `GROUP BY dict_value` 聚合，避免字典出现重复值时放大行数。

走 `idx_order_id_create_time (order_id, create_time)` 索引（实测 `type=ref`），配合 `LIMIT` 单笔查询稳定在数百毫秒内。

三条口径限制：

- `reason` **只在 `operation` 为「拦截」时才非空**（另有极少量「异常打单-自动拦截」，全表 86 种操作类型中仅此两种）。它是**拦截原因**，不是订单的通用原因字段。
- `reasonTranslated=false` 表示该编码在本库无字典，此时必须原样引用编码。
- **不返回客户资料**：人工填写的 `action_explain`（全表仅 0.06% 非空、PII 风险最高）**完全不出现在查询里**；`information` 是机器生成的状态文本并截断到 300 字符。因此查不到“客户投诉的具体内容”。

单笔订单流水均值 10.9 条，但**极值超过 10 万条**，所以 `limit` 是硬上限，超过部分通过 `mayBeTruncated` 显式告知。

## 查询安全基线

- `database-security-check` Skill 调用 `database_security_check`，通过 `SHOW GRANTS` 检查账号能否确认只读；角色授权或不认识的权限返回“需要人工确认”。
- 设置页配置最大返回行数（1–5000，默认 500）、查询超时（500–60000ms，默认 15000ms）和敏感字段规则；业务表不再设白名单。
- 业务查询只能通过内部结构化 `SELECT` 服务或代码内固定的聚合模板执行，不接受 SQL 字符串；驱动固定 `multipleStatements: false`，因此不能执行写入或多语句。
- 返回前递归屏蔽敏感字段；审计日志只记录操作类型、表名、数量、耗时和错误分类，不记录 SQL、参数、结果、凭据或驱动错误原文。
