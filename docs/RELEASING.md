# 自动生成 VSIX 与 Release 草稿

工作流：`.github/workflows/release.yml`。使用 GitHub 托管的 Windows runner 和 Node.js 24；不需要本机保持开机，也不需要配置个人 Token 或 Marketplace 凭据。发布任务使用仓库自动提供的 `GITHUB_TOKEN`，仅该任务申请 `contents: write`。

## 首次试运行（不创建 Release）

1. 在 GitHub 仓库打开 **Actions** → **Build VSIX and draft release**。
2. 点击 **Run workflow**，分支选择 **main**，再点击运行。
3. 等待 `build` 变绿。打开此次运行，在 **Artifacts** 下载 `idle-page-<版本号>`；GitHub 下载时会包装成 ZIP，解压即可取得 VSIX。这只是 Actions 的下载形式，Release 附件仍是单个 VSIX。

如果工作流被禁用，在仓库 **Settings → Actions → General** 中允许 GitHub Actions 及本流程使用的官方 `actions/*`。通常无需修改默认 Workflow permissions：工作流已显式声明所需权限；组织强制策略限制时由管理员调整。无需添加 Secrets。

## 发布新版本

先完成改动、测试并提交，再在仓库 PowerShell 执行（示例版本，按实际版本替换）：

```powershell
npm version 0.0.4 --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release 0.0.4"
git push origin main
git tag -a v0.0.4 -m "IdlePage v0.0.4"
git push origin v0.0.4
```

如果本次功能开发已更新并提交版本号，跳过前三条，不要重复增加版本。

标签必须与 `package.json`、`package-lock.json` 的版本一致。版本目前采用 `v主.次.补丁`，例如 `v0.0.4`。标签指向的提交必须包含本工作流；已有历史标签不会因新增工作流自动运行。

Actions 依次校验版本、安装锁定依赖、检查浏览器脚本、运行单元/集成测试、编译和打包、检查 VSIX 内容，然后创建 Release 草稿并上传唯一的 VSIX 附件。不生成 ZIP 发布包或 SHA256 文件。浏览器登录和 VS Code 本机交互仍需手动验收，不包含在云端检查中。

打开仓库 **Releases**，编辑生成的草稿，检查附件与版本、补充更新说明，再点击 **Publish release**。草稿包含安装模板和 GitHub 自动生成的变更记录，发布前应整理为用户能理解的说明。

## 失败与重跑

- 在 Actions 失败记录中查看红色步骤，临时网络问题可使用 **Re-run failed jobs**。
- 重跑相同标签会替换草稿中同名 VSIX，并保留已编辑的标题和说明。
- 已正式发布的 Release 不允许覆盖，需使用新版本标签。
- 代码或工作流修复后要使用包含修复的新提交和新版本标签；重跑旧任务仍使用原提交。
- 手动在 `main` 上运行只构建；手动选择版本标签运行时仍校验版本并创建/更新该标签的草稿。
