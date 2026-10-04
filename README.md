# Sobuy 工具包

`dsh-sobuy-tools-bundle` 是唯一的安装入口。它按 DSH Bundle 机制提供一层 `cordis.patch.yml`，在同一个插件包中插入两个可分别启停的组件。

```text
dsh-sobuy-tools-bundle/
├── package.json             # 唯一的 Bundle manifest（dsh.bundle）
├── cordis.patch.yml
├── client.js                # Bundle 的 Desktop 配置界面（通过裸包名 row 加载）
└── components/
    ├── feishu/              # patch 中的 dsh-sobuy-tools-bundle/feishu
    └── database/            # patch 中的 dsh-sobuy-tools-bundle/database（当前占位）
```

开发模式安装整个 Bundle：

```bash
dsh plugin --profile desktop add link:/Users/fujuntao/Documents/skills/dsh-sobuy-tools-bundle
```
