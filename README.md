# DSH 插件集合

集中管理多个独立开发、编号、打包和发布的 DeepSeek Harness（DSH）插件。

## 插件

| 插件 | 目录 | 说明 |
| --- | --- | --- |
| 书架 | [`plugins/bookshelf`](plugins/bookshelf) | 管理和阅读本地 PDF、EPUB、TXT、Markdown，显示书籍封面，保留原文件位置与阅读进度。 |
| 侧边对话 | [`plugins/side-chat`](plugins/side-chat) | 在 DSH 主会话旁进行独立文字侧聊，支持选文引用、会话恢复和归档。 |

每个插件独立维护版本、文档、测试和发布产物。

## 安装与运行

完整说明见 [安装与升级插件](docs/installation.md)。从本地 checkout 安装 bookshelf 的最短路径：

```sh
cd plugins/bookshelf
pnpm install --frozen-lockfile
pnpm run build

dsh plugin --profile web add "$PWD"
```

验证组合配置：

```sh
dsh --profile web --dump-config | grep -A2 'dsh-bookshelf'
```

然后打开或刷新 `dsh web` 页面。启用 HMR 的 profile 会尝试自动重载；没有自动出现插件入口时重启 `dsh web`。

### 从 tarball 安装

```sh
mkdir -p dist
pnpm pack --pack-destination "$PWD/dist"
dsh plugin --profile web add "$PWD/dist/dsh-bookshelf-0.1.0.tgz"
```

### 卸载

```sh
dsh plugin --profile web remove dsh-bookshelf
```

卸载不会删除 `$DSH_HOME/bookshelf/library.json` 或原书文件。书架数据保存在运行数据目录，不进入源码或发布产物。

## 开发命令

先进入对应插件 worktree 下的插件目录，例如 `.worktree/bookshelf/plugins/bookshelf/`。

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run check
```

命令与验证范围以对应插件的 README 和 `package.json` 为准。

## License

[MIT](LICENSE)
