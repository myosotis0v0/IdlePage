# IdlePage / 余页

A discreet VS Code novel reader with status bar reading, online book sources, and account authentication.

自用 VS Code 小说阅读器，通过普通 Edge 中的浏览器伴随扩展接入起点中文网。账号登录由用户在官方页面完成，书架、目录和正文读取由 VS Code 发起，在 VS Code 中查看结果。

## 功能

- 获取当前页书架书单和书籍目录。
- 获取当前账号可读取的章节正文，过滤段落评论计数。
- 在 VS Code 查看正文并切换到下一章；获取失败时保留原章和位置。
- 正文统一区分可获取与不可获取，对登录失效、内容限制或读取错误显示提醒。
- 按读取任务自动唤起专用 Edge，使用浏览器保存的登录会话连接。

目录的免费或付费标记仅供参考，可读性以账号在官方页面实际能够获取的正文为准。插件不执行购买、订阅或条件解锁；遇到访问验证时停止任务并提醒。

## 环境要求

- Windows、桌面版 VS Code 和 Microsoft Edge。
- 从源码运行需要 Node.js 22+ 和 npm。
- 一个用于运行 IdlePage 本机服务的 VS Code 窗口。

## 从源码运行

```powershell
npm ci
npm run build
```

在 VS Code 中打开项目，按 F5 并选择 **Run IdlePage**。后续命令在新打开的扩展开发窗口中执行。

## 接入起点中文网

1. 在命令面板运行 `IdlePage: 准备浏览器连接`，打开专用 Edge 的扩展管理页并复制本机配对目录。
2. 在 Edge 开启开发人员模式，加载剪贴板中的目录，确认扩展名称为 **IdlePage Browser Companion**。不要直接加载源码中的 `browser-extension/`，它不含本机配对配置。若装有旧的 **IdlePage Qidian Access Probe**，请停用它。
3. 在 VS Code 运行 `IdlePage: 重新验证接入`。需要登录时，在专用 Edge 的起点官方页面手动登录。
4. 使用书单、目录和正文命令读取内容；伴随扩展自动执行页面访问和提取，无需手动打开章节或点击提取。

辅助扩展只需首次安装。读取任务会自动唤起浏览器并连接；关闭 VS Code 服务窗口后，连接随之停止，再次运行插件并发起任务即可重新连接。

## 命令

| 命令 | 用途 |
|---|---|
| `IdlePage: 准备浏览器连接` | 打开扩展管理页，复制配对目录 |
| `IdlePage: 查看接入状态` | 查看连接和页面访问状态 |
| `IdlePage: 重新验证接入` | 发起首页与书架访问任务 |
| `IdlePage: 测试当前页书单提取` | 获取当前页书单 |
| `IdlePage: 查看当前页书单` | 显示本次书单 |
| `IdlePage: 测试第一本书目录` | 获取当前页书单第一本书的目录 |
| `IdlePage: 查看本次目录` | 显示本次目录 |
| `IdlePage: 测试第一章正文获取` | 获取当前目录第一章正文 |
| `IdlePage: 查看本次正文结果` | 显示正文或不可获取原因 |
| `IdlePage: 下一章` | 按目录顺序获取下一章 |

## 设置与连接排查

| 设置 | 默认值 | 说明 |
|---|---|---|
| `idlepage.bridge.port` | `17655` | 本机服务端口；修改后重启插件并重新加载同一配对目录 |
| `idlepage.browser.autoStart` | `true` | 发起读取任务时自动唤起专用 Edge |

连接失败时，先确认 VS Code 服务窗口运行中，以及专用 Edge 中的伴随扩展已安装并启用。伴随页的 `connectionError` 可帮助排查：

- `BridgeStatus401`：配对凭据不匹配。
- `BridgeStatus403`：来源检查失败。
- `BridgeTimeout` / `BridgeNetworkError`：本机服务超时或不可达。

## 本机数据

网站登录会话保存在专用 Edge 配置中，插件不读取或导出 Cookie。本机服务仅监听 `127.0.0.1`，使用配对扩展来源和密钥校验连接。

浏览器配置位于 `%LOCALAPPDATA%/IdlePage/qidian-probe/`；配对文件由插件生成在 VS Code 私有存储目录。请勿上传浏览器配置、配对文件或 `.local/` 中的数据。

开发方案、验证证据、进度和待办统一见 [方案与进度](docs/PLAN.md)。
