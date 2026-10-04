# 变更日志

## 未发布

- OAuth 授权页只会在本机回调端口监听成功后打开；错误 `state` 不再中断仍在等待的正确回调。
- 修复 `::1` 回环地址的回调 URL，并增加端口占用、IPv6 与回调状态回归测试。
- 登录、退出、切换应用和 token 刷新使用身份代次与提交锁，旧请求不会覆盖或删除新登录态。
- 假期余额请求使用 `employment_id_list` 与 `user_id_type=open_id` 在上游直接限定当前 OAuth 用户，避免读取租户内其他员工余额。
- 文档同步为当前 Axios 最小 API Client 实现。

## 0.8.26

- 新增 `feishu-my-user-info` Skill，统一编排当前授权用户的姓名、邮箱和手机号查询。

## 0.8.25

- `feishu_user_info` 的文字摘要展示邮箱，优先显示企业邮箱。

## 0.8.24

- `feishu_user_info` 的文字摘要展示手机号；飞书未返回手机号时明确标注“未获取到”。

## 0.8.23

- 修复带 `AbortSignal` 的飞书 SDK Client：注入完整 Axios 实例，支持 SDK 内部申请 tenant token 时的 `post()` 调用。
- 修复 `feishu_operation_logs` 严格输出 Schema，声明脱敏错误分类、错误码与 HTTP 状态字段。

## 0.8.20

- 使用官方飞书 SDK，增加 OAuth 与应用身份 Client 缓存。
- macOS Keychain 保存敏感凭据；按插件数据目录隔离。
- 增加限流/网络有限重试、分页保护、权限诊断 Skill 与操作摘要。
- 打包前自动执行语法检查和测试。

## 升级说明

首次成功登录或刷新后，macOS 会将敏感凭据迁移到 Keychain；原 JSON 仅保留状态元数据。
