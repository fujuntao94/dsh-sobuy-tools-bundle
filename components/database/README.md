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
- Skill：`database-table-catalog`，回答表数量，并只列出表名和用途。

没有填写表备注时，用途固定返回“未填写表备注”，不会根据表名猜测。此能力不查询字段、记录数或业务表数据，也不接受任意 SQL。设置页中的“已保存”只代表配置落盘，不代表连通性验证通过。

## 查询安全基线

- `database-security-check` Skill 调用 `database_security_check`，通过 `SHOW GRANTS` 检查账号能否确认只读；角色授权或不认识的权限返回“需要人工确认”。
- 设置页配置业务表白名单、最大返回行数（1–1000）、查询超时（500–30000ms）和敏感字段规则。空白名单默认禁止业务表查询。
- 业务查询只能通过内部结构化 `SELECT` 服务执行，不接受 SQL 字符串；驱动固定 `multipleStatements: false`，因此不能执行写入或多语句。
- 返回前递归屏蔽敏感字段；审计日志只记录操作类型、表名、数量、耗时和错误分类，不记录 SQL、参数、结果、凭据或驱动错误原文。
