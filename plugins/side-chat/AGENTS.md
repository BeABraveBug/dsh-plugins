# DSH Side Chat

侧边会话插件，处于实现面板与会话功能的阶段。行为要求与目标结构由 `docs/spec.md` 与 `docs/architecture.md` 描述（V1.2 产品要求，宿主接口部分验证）；实现前以它们为准，不把未验证的宿主 API 当作已具备。仓库公共规则与模型职责由根 AGENTS.md 说明。

## 项目文件结构

```text
side-chat/
├── AGENTS.md               # 插件文件结构说明与开发命令
├── README.md               # 用户说明、兼容性与已知限制
├── package.json            # dsh.bundle / dsh.client 清单、依赖与脚本
├── cordis.patch.yml        # 安装后插入 Host Loader 行
├── icon.svg                # 插件管理页展示图标
├── locale/                 # 插件标题与描述
├── docs/                   # 规格、架构与本地协作记录（comments 不发布）
├── src/
│   ├── shared/             # Host 与 Client 共用的记录与 RPC 类型
│   ├── host/               # 侧聊记录存储与认证 RPC 路由
│   └── client/             # 右栏 tab type、侧聊面板、会话桥接、持久化、选文浮层、locale 与样式
├── tests/                  # 清单、locale 与浏览器 bundle 检查
├── tsconfig.json
├── tsdown.config.ts        # Host ESM 与 Client 经典脚本 bundle
└── lib/                    # 构建产物；由 .gitignore 排除
```

## 当前边界

背景与管理已按 V1.2 接入：默认移出为归档、归档等待当前已接受任务终态、统一只读归档入口已实现；永久删除未提供（宿主删除能力未验证），自动归档因缺少可靠删除事实仍未启用。真实宿主端到端验收待完成。V1 不要求逐字流式显示。侧聊历史全量发送、不做 V1 压缩；自动压缩与主动压缩为后续功能，需另行设计。

- 已实现：右栏 tab type（`id: dsh-side-chat`、`kind: side-chat`）与面板；新建/切换/关闭并保留/恢复/归档/归档中侧聊、草稿、首次发送创建真实 Session（加入父会话所在工作区）、展示已提交消息与本轮失败；侧聊标题、草稿、引用、背景快照、管理状态、活动项与真实会话映射持久化并在刷新后恢复；主会话选文浮层把选区加入活动侧聊；首轮按引用情况自动附加主会话背景（8000 字符、可补读历史、超长标节选）；加载记录与本地新建合并，提交结果未知时阻止重试。
- 管理状态为 `open / saved / archiving / archived`；默认移出为归档，`archiving` 期间禁止新提交并等待当前任务终态；统一归档入口通过 Host `listArchived` 跨 Parent 查阅（含 `archiving` 等待项），不创建会话。永久删除入口未提供；失效会话不自动重建。
- Host 入口注册 `$DSH_HOME/side-chat/state.json` 存储与 `/api/side-chat/rpc`；Client 通过该路由读写，不直接访问文件。归档浏览使用 `listArchived` 跨 Parent 只读查询。
- 侧聊会话是真实 DSH 会话，消息由宿主持久化；插件记录只保存侧聊元数据，不复制消息。
- 已保存 `sideSessionId` 的侧聊只能恢复该会话，不能替换为新会话；提交结果未知时保存 `pendingSend`，按事件中的 `rpcId` 对账并等待用户确认。
- 创建侧聊会话时传父会话的 `workspaceId`（Host 不允许与 `cwd` 同时出现），使会话归属工作区而不是「未分组」；父会话无工作区时才退回 `cwd`。
- 发送顺序：先登记并持久化 `pendingSend`（含 `requestId`、引用快照、是否注入背景），再调用 prompt；结构化 carrier 错误按未知结果处理，只有逐项列出的明确拒绝码才允许直接重试。
- 持久化未就绪（加载中或加载失败）时禁止 `flush` 与发送，避免整份写入覆盖磁盘记录。
- 会话创建先登记 `pendingCreate.sessionId` 并持久化，再调用 create；创建失败重试复用同一 ID。
- 已发送引用来源保存在 `sentQuotes`；重放对账成功时按 `pendingSend.contextInjected` 补记背景已交付，并视为首轮已发送。
- 工具授权通过 `uiSession.sessionStatus` 的 `pendingInteraction` 读取 approval 域对象并调用 `answer('allowed-once' | 'rejected')`；这是宿主 approval 插件的当前形状，不是公开插件 API，升级时复核。参数可展开全文/复制。
- 授权卡片按 `callId` 从同一事件窗口取 `tool/call` 的 `name` 与 `arguments` 展示，支持展开全文与复制；取不到详情时只能拒绝，批准按钮禁用。`displayReason` 按当前语言解析后再回退到 `reason`。

### 背景与归档约定

- 首次发送有主动引用时不附加背景；没有引用时读取 Parent 已完成正文，按 8000 字符预算从最近向前取材，必要时 `loadOlder` 补读；遇到放不下的完整消息即停止补读（不为凑满预算继续读取），超长单条标为节选，快照冻结并持久化。补读失败、无进度或达到页数上限仍未读完时整次获取失败，不发送、不标记首轮完成；开始获取时冻结截止 seq，之后新增消息不进入快照。旧记录按已交付标记或真实会话消息推断首轮已完成。
- 背景写入 prompt 时用 `⟦side-chat-background⟧` 标记包裹；显示时只剥离本聊天快照生成的精确包裹（含旧版「主会话摘要」前缀），不按标记文字全局删除。不提供手动背景开关。
- 管理状态为 `open / saved / archiving / archived`；归档请求立即禁止新提交；有已接受任务时进入 `archiving`，任务结束后由面板转为 `archived`。两种状态查看时隐藏操作菜单；发送流程在开始、身份保存后、创建前和 prompt 前检查。统一归档入口按 `sideSessionId` 只读恢复历史，不创建会话，并包含 `archiving` 项。`archiving` 中若 `pendingSend` 结果未知，面板按 `requestId` 在历史中只读对账（不按正文匹配）；找到记录时调用正常成功结算（引用来源、草稿、首轮与背景交付）再完成归档；找不到由用户确认未提交后归档，不自动重发。确认动作会重新恢复会话、复核运行状态与 `requestId`，并再次按 `requestId` 查历史：命中走正常成功结算，未命中才清收据归档；证据不足保持等待。等待面板提供手动对账与确认按钮，事件到达时重试对账。观察到 Parent `removed` 时只提示，不自动归档。不调用宿主 `archiveSession`，未提供永久删除。

### 选文引用约定

- 选文浮层注册在 `shell.overlay`，只处理 `[data-conversation-region]` 内的选区，排除主输入框与本插件面板。
- 只有节点键以 `input-message`、`assistant-step` 或 `agent-message` 开头的消息行可引用；该命名依赖宿主实现，升级时复核。
- 会话头部按钮注册在 `conversation.session.header.utilities`（id `side-chat.open`），与右栏指南入口打开同一标签。
- 点击浮层只加入待发送引用并打开面板，不自动发送、不创建真实会话。

### 右栏接入约定

- 面板内部用下拉管理多个侧聊，不为每个侧聊新建宿主标签。
- 新增宿主能力前先在隔离 profile 中验证，并把结果记录到 `docs/comments/`。

## 开发命令

```sh
pnpm install
pnpm --filter dsh-side-chat typecheck
pnpm --filter dsh-side-chat test
pnpm --filter dsh-side-chat build
pnpm --filter dsh-side-chat check
```

## 文档

`docs/spec.md` 与 `docs/architecture.md` 描述行为要求与目标结构；`docs/CHANGELOG.md` 记录用户可感知的变化。`docs/comments/` 保存本地协作记录，不随仓库发布。
