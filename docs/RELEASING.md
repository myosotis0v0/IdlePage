# 自动生成 VSIX 与 Release 草稿

工作流：`.github/workflows/prepare-release.yml` 提供网页发版入口，`.github/workflows/release.yml` 负责构建和 Release 草稿。使用 GitHub 托管的 Windows runner 和 Node.js 24；不需要本机保持开机，也不需要配置个人 Token 或 Marketplace 凭据。使用仓库自动提供的 `GITHUB_TOKEN`，只有版本准备和草稿上传任务需要 `contents: write`，构建任务只读。

## 首次试运行（不创建 Release）

1. 在 GitHub 仓库打开 **Actions** → **Build VSIX and draft release**。
2. 点击 **Run workflow**，分支选择 **main**，再点击运行。
3. 等待 `build` 变绿。打开此次运行，在 **Artifacts** 下载 `idle-page-<版本号>`；GitHub 下载时会包装成 ZIP，解压即可取得 VSIX。这只是 Actions 的下载形式，Release 附件仍是单个 VSIX。

如果工作流被禁用，在仓库 **Settings → Actions → General** 中允许 GitHub Actions 及本流程使用的官方 `actions/*`。通常无需修改默认 Workflow permissions：工作流已显式声明所需权限；组织强制策略限制时由管理员调整。无需添加 Secrets。

## 网页一键准备新版本（推荐）

准备发布时，先确保功能代码已提交并推送到 `main`，然后：

1. 打开 **Actions → Prepare version and draft release → Run workflow**。
2. 分支选择 **main**，填写版本号，例如 `0.0.4`（不带 `v`），点击运行。
3. 自动更新 `package.json` 和锁文件、提交版本变更，并创建 `v0.0.4` 标签；然后执行测试、打包，生成带 VSIX 附件的 Release 草稿。
4. 打开 **Releases**，编辑草稿标题和更新说明，确认后点击 **Publish release**。流程不会自动公开发布。

输入版本可以等于已提交的插件版本（此时只创建标签），也可以更高；不允许回退或使用已有标签。`main` 和标签原子推送，不强推；若运行期间 main 已更新，停止并要求从最新 main 新开运行。受保护分支/标签若禁止机器人推送，会明确失败；无需为本流程关闭保护，可改用下方命令行方式按仓库权限提交。

准备任务直接调用可复用构建工作流：GitHub 默认不会让 `GITHUB_TOKEN` 推送的标签再次触发 push 工作流，因此不依赖二次触发，也不需要额外个人 Token。

该入口会实际提交版本和创建标签；只想试打包时，使用前面的 **Build VSIX and draft release**，选择 `main`。完成网页发版后，本机继续开发前运行 `git pull --ff-only`，同步机器人提交的版本变更。

## 命令行发布（备选）

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
- 网页准备步骤已成功、后续构建失败时，只重跑失败任务，不重新填写相同版本运行准备入口，也不要选 Re-run all jobs。也可在原构建工作流手动选择已生成的版本标签运行。
- 重跑相同标签会替换草稿中同名 VSIX，并保留已编辑的标题和说明。
- 已正式发布的 Release 不允许覆盖，需使用新版本标签。
- 代码或工作流修复后要使用包含修复的新提交和新版本标签；重跑旧任务仍使用原提交。
- 手动在 `main` 上运行只构建；手动选择版本标签运行时仍校验版本并创建/更新该标签的草稿。
