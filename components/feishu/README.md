# Sobuy 飞书工具插件

用于 DeepSeek Harness（DSH）Desktop 的飞书个人能力插件。它通过本机 OAuth 登录识别当前用户，只查询该用户自己的资料、部门和假期余额。

> 不支持查询他人、部门或全公司数据；不接收 `user_id`、`open_id`、员工 ID 或部门 ID 作为查询参数。

## 能力概览

### Tools

| Tool | 用途 | 返回范围 |
| --- | --- | --- |
| `feishu_login` | 查询、登录、刷新或退出本机飞书 OAuth 登录态 | 登录状态与脱敏用户名称 |
| `feishu_user_info` | 查询当前已授权用户的个人资料 | 姓名、邮箱、手机号等用户授权资料 |
| `feishu_my_departments` | 以应用身份查询当前已授权用户所在部门 | 名称、负责人名称、国际化名称、成员统计、删除状态 |
| `feishu_my_leave_balances` | 查询当前已授权用户的假期余额 | 假期类型、余额、已用额度、单位 |
| `feishu_operation_logs` | 查看当前 DSH 会话的飞书操作诊断摘要 | Tool 名称、状态、耗时、脱敏错误摘要 |
| `feishu_capabilities` | 查看插件支持范围 | 已实现能力与明确未支持的类别；不访问飞书 |

### Skills

| Skill | 适用问题 | 行为 |
| --- | --- | --- |
| `feishu-login-guide` | “登录飞书”“登录过期”“退出飞书” | 先检查登录状态，再按需执行登录、刷新或退出 |
| `feishu-my-leave-balances` | “我还有多少年假” | 直接查询并展示当前用户余额 |
| `feishu-leave-balance-diagnose` | “为什么查不到年假”“余额为空怎么办” | 查询余额；仅失败时读取脱敏操作日志给出排查建议 |
| `feishu-my-organization` | “我在哪个部门”“我的领导是谁” | 按问题只回答部门名称或负责人姓名 |
| `feishu-capability-boundary` | “帮我发消息”“创建审批”等未实现飞书需求 | 明确拒绝，不调用飞书 Tool 或 SDK |

Skills 均通过 `ctx.skills.register()` 在插件启动时注册，不依赖文件系统扫描。

## 未实现功能如何拒绝

插件只有已注册 Tool 才能访问飞书；不会提供通用 URL、SDK 方法或任意用户 ID 的调用入口。对于发送消息、审批、打卡、日历、群管理、云文档、多维表格、请假申请等未实现功能，`feishu-capability-boundary` 会直接说明不支持，且不会触发登录刷新或任何飞书请求。

此外，`ctx.tools.guard()` 会在运行时强制检查所有 `feishu_` 前缀 Tool：只有能力白名单中的 Tool 可以执行。即使后续模型或其它策略试图调用未登记的飞书 Tool，guard 也会返回最终拒绝。

## 使用流程

1. 在飞书开放平台配置应用权限与 OAuth 回调地址。
2. 在 DSH Desktop 的“设置 → 插件 → Sobuy 飞书工具”中打开飞书设置页。
3. 填写 App ID、App Secret 并在浏览器完成飞书授权。
4. 直接询问“我的年假还有多少”或调用相应 Tool/Skill。

更换 App ID 会清除旧应用签发的本机登录态，随后必须重新授权。

### 登录状态与余额查询

`feishu_my_leave_balances` 按如下顺序执行：

1. 校验当前 OAuth 登录态；用户 token 已过期或临近过期时才刷新。
2. 通过内置 Axios HTTP Client 获取或复用应用 `tenant_access_token`。
3. 以 `user_id_type=open_id` 和 `employment_id_list=<当前用户 open_id>` 请求假期余额，上游只返回当前用户记录。
4. 适配层再次校验响应中的用户标识，不向 Tool 层传递其他员工记录。

余额为空不等于余额为零，也不会触发额外登录或反复查询。

## 飞书开放平台配置

创建自建应用后，开通并发布以下 OAuth 权限：

- `offline_access`
- `contact:user.base:readonly`
- `contact:user.department:readonly`
- `contact:department.base:readonly`

如需查询假期余额，还需要申请并获批飞书人事“批量查询员工假期余额（`corehr.v1.leave.leave_balances`）”对应权限，并确认租户已启用飞书人事假期管理。

在应用的重定向地址白名单中添加：

```text
http://127.0.0.1:18080/feishu/callback
```

`redirectUri` 必须与飞书开放平台中登记的地址完全一致。新增 `offline_access` 或调整权限后，必须重新完成 OAuth 登录。

## 诊断与日志

调用 `feishu_operation_logs` 可读取当前 DSH 会话的最近飞书操作摘要，例如：

- 调用了哪个 Tool；
- 成功或失败；
- 耗时；
- 部门数量、余额类型数量等业务摘要；
- 脱敏后的错误原因。

日志按 DSH 会话隔离，只保留插件进程内最近 100 条，插件重启后清空。DSH 自身仍会持久记录标准的 Tool 调用与结果事件。本插件还监听 DSH 的 `tools/result` Hook，以补记在 Tool 本体执行前就被策略或参数校验拒绝的飞书操作。

日志与 Tool 输出不会包含 token、App Secret、授权码、`open_id`、员工 ID、部门 ID 或飞书原始接口响应。HTTP Client 不输出请求对象，避免凭据进入标准输出。

## 飞书 API Client

所有访问飞书开放平台的请求均使用 `axios` 直连插件实际需要的接口：OAuth 授权码换 token、刷新、撤销、用户资料，以及应用身份的通讯录与假期余额。OAuth 用户登录、token 的本机加密存储和登录状态判断仍由本插件的 `domains/auth/` 管理；浏览器设置页对本机服务的 `fetch` 不会访问飞书。

### 调用与权限矩阵

| 能力 | 调用身份 | Client 入口 | 必要权限/条件 | 登录态行为 |
| --- | --- | --- | --- | --- |
| OAuth 登录、刷新、退出 | OAuth 应用凭据 | `accessToken`、`request` | `offline_access`、回调地址 | 登录或临近到期才刷新 |
| 当前用户资料 | `user_access_token` | `authen.v1.userInfo.get` | `contact:user.base:readonly` | 先校验或刷新登录态 |
| 我的部门与负责人 | `tenant_access_token` | `contact.v3.user/department.get` | 用户/部门通讯录权限与可见范围 | 先校验当前 OAuth 用户 |
| 我的假期余额 | `tenant_access_token` | `corehr.v1.leave.leaveBalances` | 人事假期余额权限 | 先校验当前 OAuth 用户，并按 `open_id` 过滤 |

认证 Service 缓存应用与 OAuth HTTP Client；多个 Tool 同时发现用户 token 过期时只会执行一次刷新。带取消信号的调用使用独立 Client，因此一个已取消的 Tool 不会取消其他 Tool 的请求；登录、退出或切换应用后，在途旧请求不会覆盖新身份。

### 错误诊断

飞书原始 `msg` 会保留在 Tool 错误中，便于排查。会话日志额外标记 `authentication`、`permission`、`not_found`、`rate_limited`、`network`、`cancelled` 或 `invalid_response`，但不会记录 token、凭据或原始请求对象。

## 安全边界

- OAuth 回调仅监听 `127.0.0.1:18080`，不会暴露到局域网或公网。
- 浏览器设置页仅监听本机 `127.0.0.1:18081`；它与 OAuth 回调使用不同端口。
- 授权请求使用随机 `state`，回调只接受一次并在完成或超时后关闭。
- 应用凭据与 token 存于 `$DSH_HOME/feishu-login/`，目录权限为 `0700`、文件权限为 `0600`。
- App ID 与 App Secret 只由本机设置页提交，绝不作为 Tool 参数、Skill 内容或日志输出。
- `config.json` 与 `token.json` 已被 `.gitignore` 忽略，不应提交到 Git。

## 安装与升级

### 开发模式

将 Desktop profile 链接到当前目录：

```bash
dsh plugin --profile desktop add link:/Users/fujuntao/Documents/skills/dsh-sobuy-tools-bundle
```

保存代码后需要重载插件或重启 Desktop；Desktop 不会自动热更新插件。

### 发布模式

先启动过一次 Desktop 以初始化 profile，再在插件目录执行：

```bash
dsh plugin --profile desktop add .
dsh plugin --profile desktop list
```

重启 Desktop 后，在“设置 → 插件 → Sobuy 飞书工具”中完成配置与授权。

## 开发与验证

```bash
npm test
npm run check
npm pack --pack-destination dist
```

测试不会访问真实飞书账户。打包前请使用临时 npm 缓存（若本机默认缓存权限异常）：

```bash
npm_config_cache=/private/tmp/dsh-sobuy-feishu-tools-npm-cache npm pack --pack-destination dist
```

## 项目结构

```text
dsh-sobuy-feishu-tools/
├── index.js                 # DSH 插件入口
├── client.js                # Desktop 设置页入口
├── cordis.patch.yml         # Desktop profile 配置
├── src/
│   ├── runtime/             # Tool、Skill、Service、Hook 等 DSH 扩展入口
│   ├── domains/             # auth、organization、leave 等飞书业务实现
│   └── ui/                  # 本机设置页与 OAuth 回调页面
├── test/                    # 不访问真实飞书的自动化测试
└── dist/                    # 发布包
```

模块拆分规则见 [src/README.md](src/README.md)。
