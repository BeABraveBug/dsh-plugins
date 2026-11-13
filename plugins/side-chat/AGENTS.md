# DSH Side Chat

独立文字侧聊插件，处于从“复用 DSH 会话”迁移到“插件独立会话”的实现阶段。行为要求见 `docs/spec.md`，数据归属与模型接入见 `docs/architecture.md`；实现前以它们为准，不把未验证的宿主 API 当作已具备。仓库公共规则与模型职责由根 AGENTS.md 说明。

## 项目文件结构

```text
side-chat/
├── AGENTS.md
├── README.md
├── package.json
├── cordis.patch.yml
├── icon.svg
├── locale/
├── docs/                     # Spec、Architecture、CHANGELOG 与本地 comments
├── src/
│   ├── shared/               # 独立会话、消息与 RPC 类型
│   ├── host/                 # SQLite 存储、模型网关、RPC 路由
│   └── client/               # 右栏面板、独立会话 API、选文浮层、locale 与样式
├── tests/
├── tsconfig.json
├── tsdown.config.ts
└── lib/                      # 构建产物；由 .gitignore 排除
```

## 当前边界

独立侧聊已接入：SQLite 保存侧聊与消息、DSH 默认模型文字问答、每侧聊模型覆盖、全量历史发送、首轮主会话背景、归档等待与统一归档。旧版 DSH 侧聊不迁移；旧 `state.json` 启动时清理。真实模型、断网、并行与长历史仍待验证。

- Host 权威数据：`$DSH_HOME/side-chat/sessions.sqlite`，未设置 `DSH_HOME` 时为 `~/.dsh/side-chat/sessions.sqlite`。
- 不创建 DSH 原生会话；不调用工作区工具；模型凭据由 DSH 解析，插件不保存。
- 模型：默认 `agentDefaultModel` 当前选择；侧聊可覆盖 provider/model/reasoningEffort，只影响该侧聊。
- 历史全量发送，不做 V1 截断/压缩；模型上下文不足时报错并保留输入。自动/主动压缩是后续功能。
- 背景：首轮无引用时从 Parent 完成正文按 8000 字符取材，冻结快照；有引用时不附加；后续不自动补入；正文不在侧聊消息区显示。
- 管理状态：`open / saved / archiving / archived`。归档请求立即禁止新提交；有生成中消息时先等待，完成后只读。统一归档跨 Parent 查询，不创建会话。
- 永久删除只删除插件侧聊、消息与引用，必须独立确认；旧 DSH 会话不处理。
- 旧版 `state.json` 清理；旧 DSH 侧聊保留原工作区，不导入、不列出、不删除。

### 选文引用

- 浮层注册在 `shell.overlay`，只处理 `[data-conversation-region]` 内、节点键以 `input-message`、`assistant-step` 或 `agent-message` 开头的消息行。
- 点击只加入当前 Parent 的活动侧聊（没有则创建插件草稿），不自动发送；引用写入 Host SQLite。
- 节点键与 DOM 结构依赖宿主版本，升级时复核。

### 右栏接入

- 面板内部用下拉管理多个侧聊，不为每个侧聊新建宿主标签。
- 新增宿主能力前先在隔离 profile 验证，并记录到 `docs/comments/`。

## 开发命令

在原项目的 `.worktree/side-chat/` 根目录运行下列命令。开发分支和提交步骤见[版本与发布](../../docs/versioning-and-releases.md)。

```sh
pnpm install
pnpm --filter dsh-side-chat typecheck
pnpm --filter dsh-side-chat test
pnpm --filter dsh-side-chat build
pnpm --filter dsh-side-chat check
```

## 文档

`docs/spec.md` 与 `docs/architecture.md` 是行为与结构合同；`docs/CHANGELOG.md` 记录用户可感知变化；`docs/comments/` 为本地协作记录，不随发布。
