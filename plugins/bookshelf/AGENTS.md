# DSH Bookshelf

书架插件已实现，行为规格与目标架构见 `docs/`。仓库公共规则与模型职责由根 AGENTS.md 统一说明。

## 项目文件结构

```text
bookshelf/
├── AGENTS.md               # 插件文件结构说明与开发命令
├── README.md               # 用户说明、兼容性、验证记录与已知限制
├── package.json            # dsh.bundle / dsh.client 清单、依赖与脚本
├── cordis.patch.yml        # 安装后插入 Host Loader 行
├── icon.svg                # 插件管理页展示图标
├── locale/                 # 插件标题与描述
├── docs/                   # 规格、架构与本地协作记录（comments 不发布）
├── src/
│   ├── host/               # 书架记录、目录扫描、可用性检查、认证 HTTP 路由
│   ├── shared/             # Host 与 Client 共用的 JSON 协议类型
│   └── client/             # React 书架、添加窗口、PDF/EPUB/TXT/Markdown 阅读器
├── tests/                  # Vitest 行为测试与可公开样例（测试内生成）
├── tsconfig.json
├── tsdown.config.ts        # Host ESM 与 Client 经典脚本 bundle
└── lib/                    # 构建产物；由 .gitignore 排除
```

## 边界

- Host 侧是书目和阅读状态的唯一写入者；Client 只通过 `ctx.connection` 上已认证的精确 Fetch 路由读写。
- 插件只读取原文件，不复制、修改、移动或删除原文件。
- 书目、笔记和问答消息分别保存在 `$DSH_HOME/bookshelf/` 下的 `library.json`、`notes.json` 和 `conversations.json`，不进入源码或发布产物。
- Client 不直接访问 `ctx`；组件通过 `apply` 闭包提供的普通回调和数据工作。

## 开发命令

在原项目的 `.worktree/bookshelf/plugins/bookshelf/` 中运行下列命令。按本插件的 `packageManager` 使用 pnpm，依赖版本以本目录的 `pnpm-lock.yaml` 为准。开发分支和提交步骤见原项目根目录的 `docs/versioning-and-releases.md`。

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
```

`lib/` 是构建产物。安装到 DSH profile 前先执行 build。
