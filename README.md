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

### 默认方式（使用 GitCode 镜像仓的 hooks）

```yaml
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

### 使用自定义执行机（适用于非 GitCode 镜像仓的 hooks）

当 `.pre-commit-config.yaml` 中配置的 hooks 仓库地址不是 GitCode 镜像仓时（例如使用了 GitHub 等外部仓库的 hooks），云端执行机可能无法访问这些外部地址。此时可以通过自定义执行机（self-hosted runner）来运行，自定义执行机可以访问外部网络资源。

```yaml
jobs:
  pre-commit:
    runs-on: ['self-hosted', 'os=ubuntu', 'arch=x64']
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

> **说明**：`runs-on: ['self-hosted', 'os=ubuntu', 'arch=x64']` 表示使用自定义执行机运行流水线，适用于 hooks 来源为 GitHub 等外部仓库的场景。

## 自动修复

当检查项仅包含以下代码风格类 hook 时，支持自动修复并推送修复后的代码：

- `clang-format`
- `ruff-format`
- `trailing-whitespace`
- `end-of-file-fixer`

如果配置了上述以外的其他检查项，则不会触发自动修复，仅输出检查结果。

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
