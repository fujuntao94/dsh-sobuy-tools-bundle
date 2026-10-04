# src 架构

目录按 DeepSeek Harness（DSH）的扩展模型划分：**运行时扩展**与**飞书业务领域**分离。

```text
src/
├── runtime/                         # DSH 直接装配的扩展点
│   ├── tools/                       # ctx.tools.register()
│   ├── skills/                      # ctx.skills.register()
│   ├── services/                    # ctx.provide()
│   └── hooks/                       # ctx.on(...)
  ├── domains/                         # 不直接注册到 DSH 的飞书业务与 SDK adapter
│   ├── auth/                        # OAuth、token、登录页服务、本机私有存储
│   ├── organization/                # 通讯录与当前用户部门 API
│   └── leave/                       # 假期余额 API
└── ui/
    └── pages/                       # 本机设置页与 OAuth 回调页 HTML
```

## 装配顺序

根目录 `index.js` 只做 DSH 生命周期装配，不包含飞书 API 细节：

1. 注册 `runtime/services/`：`ctx.feishuAuth`、`ctx.feishuTelemetry`。
2. 注册 `runtime/hooks/`：监听 `tools/result`，补充最终结果诊断。
3. 注册 `runtime/tools/`：把模型可调用能力加入 DSH Tool Runtime。
4. 注册 `runtime/skills/`：把路由与使用规则加入 Skill Registry。

## 一次“查询我的假期余额”的流程

```text
用户问题 / Skill
  → runtime/skills/leave-balance-*.js（选择查询或诊断流程）
  → runtime/tools/leave-balance-tool.js（模型调用入口）
  → runtime/services/feishu-auth-service.js（当前 OAuth 身份、SDK Client 缓存、并发刷新合并）
  → domains/auth/*（读取、校验或刷新 token）
  → domains/leave/leave-balance-api.js（SDK adapter：请求飞书接口并筛选当前用户）
  → Tool 结果
  → runtime/hooks/feishu-tool-hooks.js（观察最终结果）
  → runtime/services/operation-telemetry-service.js（记录脱敏会话摘要）
```

## 依赖规则

- `runtime/tools/` 可以依赖 `runtime/services/` 与 `domains/`。
- `runtime/skills/` 只描述何时调用哪个 Tool，不直接访问飞书 API 或 token。
- `runtime/hooks/` 只监听 DSH 事件；除非明确是策略 Hook，否则不改写 Tool 结果。
- `runtime/services/` 可以依赖 `domains/`，提供跨多个 Tool 共享的能力。
- `domains/` 不得依赖 `runtime/`，从而保持 OAuth、组织和假期逻辑可独立测试。
- `domains/*/*-api.js` 是 SDK adapter：只负责 SDK 参数、响应校验和领域数据转换；不得把 SDK 调用散落到 Tool/Skill。
- `ui/pages/` 只负责本机浏览器页面，不承担认证或业务决策。

## 新增能力的放置方式

- 新的模型动作：新增 `runtime/tools/<name>-tool.js`。
- 新的路由/工作流说明：新增 `runtime/skills/<name>-skill.js`。
- 多个 Tool 共享的状态或能力：新增 `runtime/services/<name>-service.js`。
- 监听或拦截 DSH 生命周期：新增 `runtime/hooks/<name>-hooks.js`。
- 实际飞书 API、OAuth 或领域规则：新增或扩展 `domains/<domain>/`；所有飞书开放平台请求都通过 `domains/auth/feishu-sdk.js` 提供的官方 SDK Client 调用。

最后只在根目录 `index.js` 显式装配新文件。
