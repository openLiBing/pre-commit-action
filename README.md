# openlibing-pre-commit-action

## 简介

安装 pre-commit 并对代码仓库执行钩子检查。支持 PR 增量检查和全量检查自动切换。

## 输入参数

| 参数 | 说明 | 必填 | 默认值 |
|------|------|------|--------|
| extra_args | pre-commit 运行参数。为空时自动判断：PR 事件检查增量文件，非 PR 检查全量；填写时按指定参数执行 | 否 | 空（自动判断） |

## 输出参数

| 参数 | 说明 |
|------|------|
| result | 运行结果：success 或 failed |
| checked_files | 检查的文件范围 |

## 使用示例

### 推荐方式：使用自定义执行机（推荐）

当 `.pre-commit-config.yaml` 中配置的 hooks 仓库地址不是 GitCode 镜像仓时（例如使用了 GitHub 等外部仓库的 hooks），云端执行机可能无法访问这些外部地址。推荐通过自定义执行机（self-hosted runner）来运行，自定义执行机可以访问外部网络资源。流水线配置如下：

```yaml
jobs:
  pre-commit:
    runs-on: ['self-hosted', 'os=ubuntu', 'arch=x64']  # ⚠️ 自定义执行机：必须包含 'self-hosted'，其余标签根据执行机注册时的标签填写，用于精确调度
    steps:
      - name: checkout
        uses: checkout

      - name: setup-python
        uses: setup-python

      - name: run pre-commit
        uses: openlibing-pre-commit-action
        with:
          extra_args: ${{ inputs.extra_args }}
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
    runs-on: ['codearts-hosted', 'ubuntu-latest', x64, 'large']  # ☁️ 云端执行机：使用 codearts-hosted 提供的云端运行环境
    steps:
      - name: checkout
        uses: checkout

      - name: setup-python
        uses: setup-python

      - name: run pre-commit
        uses: openlibing-pre-commit-action
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

  # ✅ GitCode 镜像仓 — clang-format 代码格式化，无需自定义执行机
  - repo: https://atomgit.com/openlibing/mirrors-clang-format
    rev: v1.0.0
    hooks:
      - id: clang-format

  # ✅ GitCode 镜像仓 — gitleaks 敏感信息扫描，国内网络可使用镜像仓加速下载
  # 安装说明：自动安装依赖 Go 运行环境，国内网络无代理建议先手动下载并安装 Go 环境：https://golang.google.cn/dl
  - repo: https://gitcode.com/GitHub_Trending/gi/gitleaks
    rev: v8.30.1
    hooks:
      - id: gitleaks
        entry: gitleaks dir
```

> **判断依据**：hooks 的 `repo` 地址以 `https://atomgit.com/` 或 `https://gitcode.com/` 开头的是 GitCode 镜像仓，云端执行机可直接访问；以 `https://github.com/` 或其他外部地址开头的，需要使用自定义执行机。

## 自动修复

当检查项仅包含以下代码风格类 hook 时，支持自动修复并推送修复后的代码：

- `clang-format`
- `ruff-format`
- `trailing-whitespace`
- `end-of-file-fixer`

如果配置了上述以外的其他检查项，则先运行其他检查项，如果通过后，才会运行这些代码风格类的检查和修复。

### 配置方式

自动修复需要在组织中配置 Actions 密钥 `GC_TOKEN`，用于修复代码的推送。配置步骤：

1. 进入组织（或仓库）的 **Settings → Secrets → Actions**
2. 新建密钥，名称为 `GC_TOKEN`，值为具有代码推送权限的访问令牌

> **注意**：未配置 `GC_TOKEN` 时，即使检查项符合自动修复条件，也不会执行自动修复推送。

## 注意事项

- 运行前需先使用 `checkout` 检出代码
- 运行前需先使用 `setup-python` 配置 Python 环境
- 项目根目录需包含 `.pre-commit-config.yaml` 配置文件
- PR 增量检查依赖 `ATOMGIT_BASE_REF` 和 `ATOMGIT_HEAD_REF` 环境变量
