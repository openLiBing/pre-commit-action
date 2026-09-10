# pre-commit-action

## 简介

安装 pre-commit 并对代码仓库执行钩子检查。支持 PR 增量检查和全量检查自动切换。非 PR 类型触发时，会读取约定报告目录下的 gitleaks JSON 扫描报告，转换为 SARIF 2.1.0 上传到 OBS，并回调 openlibing 后端。

## 输入参数

| 参数       | 说明                                                                                           | 必填 | 默认值         |
| ---------- | ---------------------------------------------------------------------------------------------- | ---- | -------------- |
| extra_args | pre-commit 运行参数。为空时自动判断：PR 事件检查增量文件，非 PR 检查全量；填写时按指定参数执行 | 否   | 空（自动判断） |
| report-dir | 各工具扫描报告约定目录（机器临时目录，非代码仓目录）。插件读取该目录下 gitleaks JSON 报告，转 SARIF 上传 OBS 并回调 openlibing 后端。PR 类型触发不进行报告上传回调 | 否   | /tmp/pre-commit-reports/ |
| debug      | 开启 SDK 调试定位日志（请求/响应详情，敏感字段自动脱敏）                                        | 否   | false          |

> **报告上传约定**：需在 `.pre-commit-config.yaml` 中为 gitleaks 钩子配置报告输出参数（`--report-path /tmp/pre-commit-reports/gitleaks.json --report-format json`），插件读取该目录下的 `gitleaks*.json` 转 SARIF 上传。PR 类型触发（mr / pull_request / note）不做报告扫描上传回调。

## 输出参数

| 参数          | 说明                        |
| ------------- | --------------------------- |
| result        | 运行结果：success 或 failed |
| checked_files | 检查的文件范围              |

## 使用示例

### 推荐方式：使用自定义执行机（推荐）

当 `.pre-commit-config.yaml` 中配置的 hooks 仓库地址不是 GitCode 镜像仓时（例如使用了 GitHub 等外部仓库的 hooks），云端执行机可能无法访问这些外部地址。推荐通过自定义执行机（self-hosted runner）来运行，自定义执行机可以访问外部网络资源。流水线配置如下：

```yaml
jobs:
  pre-commit:
    name: pre-commit
    runs-on: ["self-hosted", "os=ubuntu", "arch=x64"] # ⚠️ 自定义执行机：必须包含 'self-hosted'，其余标签根据执行机注册时的标签填写，用于精确调度
    steps:
      - name: checkout
        uses: checkout

      - name: setup-python
        uses: setup-python
        with:
          python-version: "3.14"

      - name: run pre-commit
        uses: openlibing/pre-commit-action@v1.0.0
        with:
          extra_args: ${{ inputs.extra_args }}
          gc_token: ${{ inputs.GC_TOKEN }}
```

> **关于 `runs-on`**：`'self-hosted'` 为固定必填项，表示使用自定义执行机；后续标签（如 `'os=ubuntu'`、`'arch=x64'`）需与执行机注册时设置的标签一致，流水线将根据标签精确调度到对应的执行机。

#### 自定义执行机准备工作

1. **安装执行机代理**：在组织或仓库的 **Settings → Actions → Runners** 中按照指引下载并安装 self-hosted runner 代理程序
2. **网络要求**：执行机需能访问外部网络（如 GitHub），以便拉取 hooks 仓库
3. **标签配置**：自定义执行机通过 `runs-on: ['self-hosted', 标签]` 的方式使用，注册执行机时可添加自定义标签（如 `os=ubuntu`、`arch=x64`），流水线将根据标签精确调度到对应的执行机

#### 对应的 .pre-commit-config.yaml 示例

以下示例中的 hooks 来自 GitHub 等外部仓库，云端执行机无法访问，**需要使用自定义执行机**，配置如下：

```yaml
repos:
  # ❌ GitHub 仓库 — pre-commit 官方检查工具，云端执行机无法访问，需要自定义执行机
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.6.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer

  # ❌ GitHub 仓库 — Python 代码格式化，同样需要自定义执行机
  - repo: https://github.com/psf/black
    rev: 24.4.2
    hooks:
      - id: black

  # ❌ GitHub 仓库 — gitleaks 敏感信息扫描，需要自定义执行机
  # 安装说明：自动安装依赖 Go 运行环境，有外网代理可自动编译安装（200M+）
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.30.1
    hooks:
      - id: gitleaks
        entry: gitleaks dir
```

### 云端执行机（仅使用 GitCode 镜像仓的 hooks）

如果 `.pre-commit-config.yaml` 中所有 hooks 均来自 GitCode 镜像仓，可直接使用云端执行机运行，流水线配置如下：

```yaml
jobs:
  pre-commit:
    name: pre-commit
    runs-on: ["codearts-hosted", "ubuntu-latest", x64, "large"] # ☁️ 云端执行机：使用 codearts-hosted 提供的云端运行环境
    steps:
      - name: checkout
        uses: checkout

      - name: setup-python
        uses: setup-python
        with:
          python-version: "3.14"

      - name: run pre-commit
        uses: openlibing/pre-commit-action@v1.0.0
        with:
          extra_args: ${{ inputs.extra_args }}
```

#### 对应的 .pre-commit-config.yaml 示例

以下示例中的 hooks 均来自 GitCode 镜像仓，云端执行机可直接访问，**无需自定义执行机**，配置如下：

```yaml
repos:
  # ✅ GitCode 镜像仓 — pre-commit 官方检查工具，国内网络可使用 gitcode 镜像仓加速下载
  - repo: https://gitcode.com/gh_mirrors/pr/pre-commit-hooks
    rev: v4.6.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer

  # ✅ GitCode 镜像仓 — gitleaks 敏感信息扫描，国内网络可使用镜像仓加速下载
  # 安装说明：自动安装依赖 Go 运行环境，国内网络无代理建议先手动下载并安装 Go 环境：https://golang.google.cn/dl
  - repo: https://gitcode.com/GitHub_Trending/gi/gitleaks
    rev: v8.30.1
    hooks:
      - id: gitleaks
        entry: gitleaks dir
```

> **判断依据**：hooks 的 `repo` 地址以 `https://gitcode.com/` 开头的是 GitCode 镜像仓，云端执行机可直接访问；以 `https://github.com/` 或其他外部地址开头的，需要使用自定义执行机。

## GC_TOKEN 配置

`GC_TOKEN` 用于访问私有仓库（私仓）时进行身份认证，区分私仓的访问权限。

### 配置方式

需要在组织中配置 Actions 密钥 `GC_TOKEN`，配置步骤：

1. 进入组织（或仓库）的 **Settings → Secrets → Actions**
2. 新建密钥，名称为 `GC_TOKEN`，值为具有代码访问权限的访问令牌

## 注意事项

- 运行前需先使用 `checkout` 检出代码
- 运行前需先使用 `setup-python` 配置 Python 环境
- 项目根目录需包含 `.pre-commit-config.yaml` 配置文件
- PR 增量检查依赖 `ATOMGIT_BASE_REF` 和 `ATOMGIT_HEAD_REF` 环境变量
