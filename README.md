# Sobuy 工具包

`dsh-sobuy-tools-bundle` 是唯一的安装入口。它按 DSH Bundle 机制提供一层 `cordis.patch.yml`，在同一个插件包中插入两个可分别启停的组件。

```text
dsh-sobuy-tools-bundle/
├── package.json             # 唯一的 Bundle manifest（dsh.bundle）
├── cordis.patch.yml
├── client.js                # Bundle 的 Desktop 配置界面（通过裸包名 row 加载）
└── components/
    ├── feishu/              # 由根包 dsh-sobuy-tools-bundle 加载的飞书运行逻辑
    └── database/            # 独立数据库设置页（当前只保存配置）
```

开发模式安装整个 Bundle：

```bash
dsh plugin --profile desktop add link:/Users/fujuntao/Documents/skills/dsh-sobuy-tools-bundle
```

Desktop 中会显示飞书和数据库两个设置项。数据库设置页监听
`http://127.0.0.1:18082/database/setup`，只允许从本机访问。

数据库组件内置 `database-table-catalog` Skill，只读返回基础表数量、表名和表备注用途。
同时内置 `database-security-check` Skill，用于检查账号只读状态和查询安全策略。

数据库组件还提供 `database_soldout_attribution` Tool 与 `database-soldout-attribution` Skill：
默认聚合**全部当前待处理**的缺货 SKU 与仓库；可切换近 N 天（上限 45 天）历史复盘口径，并对照当前库存、库存明细、预警、关联货柜和上架任务输出主因、并发因素、分组证据与建议动作。
SQL 为代码内固定模板，模型只能选聚合维度与填参数，不接受 SQL 字符串；固定读取
`oms_t_orders_tracking`、`oms_t_inventory`、`oms_t_inventory_detail`、`early_warn_inventory_info`、
`bas_t_container`、`bas_t_container_sku` 和 `bas_t_work_stock`，不要求手工配置业务表白名单。

`database_inventory_shortage_forecast` 专门回答“还未缺货但即将断货”：它只聚合
`report_t_predict_sku` 当前月预测销量与 `oms_t_inventory` 当前库存，输出库存覆盖天数、缺口、候选调拨库存、预测责任人和建议动作，不扫描订单缺货明细。

`database_soldout_snapshot_capture` 会从上述只读查询采集当前待处理缺货队列并保存到插件私有目录；
`database_soldout_snapshot_compare` 比较最近两份快照。两者都不会向 OMS 写数据。

同一套固定模板机制还提供两个只读 Tool：

- `database_dictionary_lookup`（Skill `database-dictionary-lookup`）：查字典目录与字典取值，
  含订单原因码 G 码。注意 `reason` 是混合编码，只有 G 码有字典，实测翻译命中率约 50.9%。
- `database_order_timeline`（Skill `database-order-timeline`）：按订单号返回单笔订单的完整操作
  流水（改单轨迹），含操作类型、原因码及翻译、说明与操作人。原因码只在「拦截」类操作上才有值；
  人工填写的 `action_explain` 不返回，`information` 截断到 300 字符。

## 工具 schema 必须落在宿主支持的子集内

宿主 `tools.register()` 会对 `output.schema` 强制校验，不合规就抛 `JsonSchemaError`。
这个异常发生在**插件 entry 激活阶段**，所以只要有一个字段写错，整个组件（含其它完全正常的
工具）都会显示「启用失败」，而不是只有那一个工具不可用。

写工具 schema 时记三条：

1. **只能用单一标量 `type`**。可空字段写 `oneOf: [{ type: 'x' }, { type: 'null' }]`，
   或用 `sobuy-plugin-core/schema` 的 `nullableSchema(type, description)`。
   `type: ['number', 'null']` 会让整个组件激活失败。
2. 关键字白名单只有 `type` / `oneOf` / `properties` / `required` / `additionalProperties`
   / `items` / `enum` / `const`，外加注解 `description` / `title` / `default` / `examples`。
   `minimum`、`maxLength` 这类只能出现在工具参数（parameters）里，**不能出现在输出 schema**。
3. 输出值在运行时也按 `output.schema` 校验，把可空字段声明成单类型即使注册通过、运行到那一步也会失败。

两道防线：

```bash
npm test                      # test/tool-schema.test.js：用本仓复刻规则验全部已注册工具的 schema
npm run check:host-schema     # 用宿主 app.asar 里的**原文校验器**再验一遍（可加 --live 连真实库验输出值）
```

单测是防回归的常驻闸门；`check:host-schema` 用于调试激活失败，判定与宿主完全一致。
