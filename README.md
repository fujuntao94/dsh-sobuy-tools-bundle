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
