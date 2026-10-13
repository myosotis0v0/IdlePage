# IdlePage / 余页

A discreet VS Code novel reader with status bar reading, online book sources, and account authentication.

自用 VS Code 状态栏小说阅读器。目标是仅登录/重新登录需要手动操作，登录后自动获取书架、目录和可读章节并保存本地进度。目前已实现桌面 VS Code 插件内的本机连接服务及配对浏览器辅助扩展；当前页真实书单提取与核对已通过，第一本书目录已接通，阅读进度快捷链接的过滤修复待真实复测；自动分页、正文和阅读体验尚未实现。

## 目录

- `src/`：正式插件入口、任务调度、观察结果契约、本机服务和普通 Edge 启动代码，不导入 `labs/`。
- `browser-extension/`：配对浏览器辅助扩展模板，随插件发布；实际安装目录由插件在本机生成。
- `tests/`：正式代码的单元、HTTP 集成、浏览器工作进程模拟和真实 VS Code 宿主测试。
- `labs/qidian/`：独立接入实验，保留原有 Playwright 和普通浏览器原型，不发布。
- `docs/PLAN.md`：唯一共享方案与进度文件，通过 Git 同步。
- `.local/`：本机报告、隔离 VS Code 配置和日志，不提交。

## 尝试 VS Code 内置本机服务

开发环境需要 Windows、Node.js 22+、桌面 VS Code 和 Microsoft Edge。

```powershell
npm ci
npm run build
npm test
npm run test:extension
npm run dev:live
```

`dev:live` 打开持续运行的 VS Code 开发窗口，自动激活 IdlePage 并打开普通 Edge 的扩展管理页。配对目录已复制到剪贴板，在 Edge 开发人员模式中加载此目录。停用旧的 **IdlePage Qidian Access Probe** 实验扩展，避免两个测试同时运行。一次性安装后，**IdlePage Browser Companion** 自动连接并执行 VS Code 下发的任务，无需点击提取。当前 dev:live 自动开启第一本书目录测试，依次获取当前页书单和第一本书目录，并在 VS Code 显示目录核对页。

也可以在当前项目按 F5，选择 Run IdlePage；然后在开发窗口运行命令 `IdlePage: 准备浏览器连接`，加载该窗口生成的配对目录。不要直接加载源码 `browser-extension/`，其中不包含运行所需的本机配对文件。

当前链路：普通浏览器内容脚本 → 浏览器工作进程 → `http://127.0.0.1:17655` → VS Code 扩展宿主 → 状态栏。浏览器通过 POST 轮询本机任务，避免扩展 GET 请求缺少 Origin。服务仅监听 IPv4 回环地址，检查 Host、配对扩展 Origin 和本机密钥。网站登录会话始终由普通浏览器保存，插件不读取或导出 Cookie。

命令：

- `IdlePage: 查看接入状态`：查看脱敏观察结果。
- `IdlePage: 准备浏览器连接`：打开 Edge 并复制本机配对目录。
- `IdlePage: 重新验证接入`：创建新任务，浏览器自动重新执行首页→书架验证。
- `IdlePage: 测试当前页书单提取`：自动打开书架、等待书目稳定并显示当前页核对结果。
- `IdlePage: 查看当前页书单`：重新显示本次核对页。
- `IdlePage: 测试第一本书目录`：自动选择当前页书单的第一本书并提取目录。
- `IdlePage: 查看本次目录`：重新显示目录核对页。

更新浏览器辅助扩展后，在 Edge 扩展管理页对 IdlePage Browser Companion 重新加载一次。若验证页仍显示 disconnected，可查看 connectionError：BridgeStatus401 表示配对凭据不匹配，BridgeStatus403 表示来源检查失败，BridgeTimeout/BridgeNetworkError 表示服务超时或网络请求失败；不要复制或发送配对密钥。

当前默认只支持一个服务窗口。设置 `idlepage.bridge.port` 可以修改端口，修改后重启插件并重新加载同一配对目录。宿主自动测试使用隔离配置和 17656 端口，避免干扰 17655 上的交互测试。关闭开发窗口会停止其服务；浏览器扩展稍后自动尝试重新连接本机服务，不循环刷新起点。

状态栏显示“书架访问完成”只说明当前页面访问诊断完成，不能证明真实书单、完整正文、订阅权益或长期稳定性。2026-10-13 普通 Edge 的真实首页→书架→VS Code 回传已通过；浏览器关闭后的整条链路恢复仍需实测。浏览器必须运行；产品级自动启动恢复尚未实现。空书架没有书籍链接时当前诊断会保持 Indeterminate，不据此判定登录失败或书架为空。

2026-10-13 当前页书单提取实测返回 11 本，strategy=table、truncated=false，用户确认书名、数量和链接与当前书架页一致。提取器限定书架表格或已知容器，去重封面链接并排除推荐区域；未知 DOM 标为候选结果。结果最多 100 本并限制为 12 KiB，超限明确标记截断。书名明细仅保存在本机内存和 VS Code 核对页中，连接状态文件与浏览器存储仅保留摘要。未检测到分页控件不能视为全量书架已取得；后续单独测试分页和完整性。

## 原有功能验证

```powershell
npm run check:labs
npm run probe:qidian
npm run login:qidian
npm run manual:qidian
npm run companion:qidian
npm run test:labs
```

Playwright 沙箱配置修正后仍遇到起点访问验证。普通 Edge 的独立原型已由用户反馈 `probe-complete / bookshelf`；该原型将结果保存在浏览器自身，与新的本机连接版本分开。

浏览器配置位于 `%LOCALAPPDATA%/IdlePage/qidian-probe/`，配对密钥保存在 VS Code SecretStorage，并写入该窗口的私有辅助扩展目录供本机连接使用。不要上传浏览器配置、配对文件或 `.local/`。详细证据与未完成事项见 [方案与进度](docs/PLAN.md)。