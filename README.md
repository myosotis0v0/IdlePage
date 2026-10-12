# IdlePage / 余页

A discreet VS Code novel reader with status bar reading, online book sources, and account authentication.

在 VS Code 状态栏中阅读小说的自用扩展。目标是仅登录/重新登录需要手动操作，登录后自动获取书架、目录和可读章节并保存本地进度。当前正在验证起点接入能力，尚未实现正式扩展。

## Project layout

- `src/`: 正式插件代码，按入口、应用逻辑、领域模型、书源基础设施、UI 分层。
- `labs/qidian/`: 起点接入验证脚本，不随插件发布。
- `tests/`: 正式插件的单元、集成及扩展宿主测试，当前尚无正式测试。
- `docs/PLAN.md`: 唯一的共享方案与进度文件，通过 Git 同步到 GitHub。
- `.local/`: 本机实验报告和运行日志，不提交。

详细目录职责、验证标准和当前结果见 [方案与进度](docs/PLAN.md)。

## Feasibility probes

需要 Node.js 22+ 和已安装的 Microsoft Edge。

```powershell
npm ci
npm run check:labs
npm run probe:qidian
npm run login:qidian
```

`probe:qidian` 访问三个公开入口并记录脱敏页面信号；HTTP 状态码不能单独作为接入成功证据。

`login:qidian` 打开独立浏览器配置，手动登录并访问书架及章节；每 5 秒只读取当前页面 DOM 信号，不刷新页面、不自动点击、不发送章节购买请求。关闭整个专用浏览器窗口即可结束。运行期间避免重复启动，以免配置目录锁冲突。

```powershell
npm run manual:qidian
```

`manual:qidian` 打开无 Playwright 控制的普通 Edge 独立配置，仅用于人工访问对照。它不会自动读取账号、书架或正文，也不会将会话导入 Playwright。

浏览器配置位于 `%LOCALAPPDATA%/IdlePage/qidian-probe/`，不使用你日常浏览器配置；报告位于 `.local/qidian/`。不要将这些目录上传到 GitHub。

根目录 `package.json` 当前是实验工具清单，尚非完整 VS Code 扩展清单。正式插件发布前补全扩展入口、贡献点及构建配置。

## Automation requirement

目前的 `login:qidian` 和 `manual:qidian` 仅用于实验对照，不是正式阅读流程。下一步验证普通浏览器伴随扩展与自动任务桥接；正式使用不得要求点击提取、手动打开章节或复制 Cookie。网站访问验证仍是待解决的可行性阻塞点。
