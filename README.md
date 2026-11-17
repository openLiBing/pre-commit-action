## 简介

安装 pre-commit 并对代码仓库执行钩子检查。支持 PR 增量检查和全量检查自动切换。检查结束后收集 SARIF 报告：优先使用用户提供（`sarif-file` / `report-dir`）的报告；工具未提供且插件支持日志解析时，自动解析 pre-commit 日志兜底生成 `<tool>.sarif`。报告文件通过 `sarif-files` output 输出，**上传与归档由 workflow 中的 openlibing-upload-sarif 完成**，本插件不做上传回调。

## 工作模式

| 触发事件                   | 检查方式                                    | 说明               |
| -------------------------- | ------------------------------------------- | ------------------ |
| PR（mr/pull_request/note） | `--from-ref origin/<baseRef> --to-ref HEAD` | 仅检查 PR 变更文件 |
| 其他事件                   | `--all-files`                               | 全量检查所有文件   |

PR 增量检查流程：

1. 直接使用 checkout 全量检出（`fetch-depth: 0`）已生成的基线远端 ref `origin/<baseRef>`，无需插件自行认证 fetch
2. 执行 `pre-commit run --from-ref origin/<baseRef> --to-ref HEAD`
3. 若 `origin/<baseRef>` 不存在：存量调用方仍传入 `gc_token` 时，走原 `GIT_ASKPASS` 认证 fetch 兼容路径（日志打印 `[DEPRECATED]`）；未传 `gc_token` 时回退无凭证 `git fetch origin <baseRef>`，失败即明确报错退出并提示配置 `fetch-depth: 0`

> 推荐配置：PR 场景的 checkout 步骤配置 `fetch-depth: 0`（全量检出），这是最可靠的方式。`gc_token` 输入**已废弃（仅兼容保留）**，新接入无需传；存量 workflow 可继续使用，但建议迁移后删除。

## 输入参数

| 参数       | 说明                                                                                                                                                                                                                                                               | 必填 | 默认值                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------ |
| gc_token   | 【已废弃，仅兼容】基线 ref 缺失时用于 `git fetch` 认证；新接入请改用 checkout 的 `fetch-depth: 0`，无需传入                                                                                                                                                        | 否   | 空                       |
| extra_args | pre-commit 运行参数。为空时自动判断：PR 事件检查增量文件，非 PR 检查全量；填写时按指定参数执行                                                                                                                                                                     | 否   | 空（自动判断）           |
| report-dir | SARIF 报告约定目录（机器临时目录，非代码仓目录）。插件扫描该目录下 `*.sarif` 作为用户提供的报告；工具未提供时按支持列表解析 pre-commit 日志兜底生成 `<tool>.sarif` 到该目录。只生成报告文件，上传由 workflow 中 openlibing-upload-sarif 完成                       | 否   | /tmp/pre-commit-reports/ |
| sarif-file | SARIF 文件/目录路径，逗号分隔支持多值（与 openlibing-upload-sarif 的 `sarif_file` 一致）：单个文件、多个文件、单个目录、多个目录（目录自动扫描其中所有 `.sarif` 文件，非递归）。填写后优先于 `report-dir` 目录扫描；未填写时回退扫描 `report-dir` 目录下 `*.sarif` | 否   | 空（回退 report-dir）    |

> **报告生成约定**：报告数据源优先级为 ① 输入 `sarif-file` 指定的文件/目录（支持逗号多值）；② 报告目录 `report-dir` 下已有的 `*.sarif`；③ 均无且日志有失败钩子时走兜底能力。同一工具已提供报告则直接使用，不再日志解析。插件只负责生成报告文件，**不负责上传回调**（SARIF 的 uri 归一化与代码上下文补齐由 openlibing-upload-sarif 统一完成）。

## 输出参数

| 参数        | 说明                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| sarif-files | 收集/兜底生成的 SARIF 文件绝对路径列表（逗号分隔，可空），可直接传给 openlibing-upload-sarif 的 `sarif-file` input |

> 运行结果不通过 output 暴露：PR 门禁场景失败直接 `exit(1)` 使 step 失败（流水线状态即结果）；版本级触发场景失败仅告警提示。

## 环境变量（镜像源配置，强烈建议配置）

插件安装 pre-commit 及各语言钩子依赖时需要访问 PyPI / Go module proxy。**未配置时回退官方源**（pypi.org / proxy.golang.org），功能可用但速度极慢，慢网/内网 runner 可能明显变慢甚至超时。实测数据（未配置镜像、走 PyPI 官方源）：`virtualenv` 单包 5.6MB 下载速率约 30 KB/s、耗时 3 分 52 秒，整个 job 约 6 分钟。

> **版本要求**：本节环境变量自 **v1.1.0** 起生效；v1.0.3 及更早版本的镜像地址为代码内固定值，不读取这两个变量（配置了也不会报错，仅不生效）。

| 环境变量           | 作用                                   | 推荐值（华为云镜像）                                     | 未配置时回退     |
| ------------------ | -------------------------------------- | -------------------------------------------------------- | ---------------- |
| PIP_MIRROR_DEFAULT | pip 安装 pre-commit 及 Python 钩子依赖 | `https://mirrors.huaweicloud.com/repository/pypi/simple` | pypi.org 官方源  |
| GO_PROXY_DEFAULT   | Go 语言钩子依赖下载代理                | `https://mirrors.huaweicloud.com/repository/goproxy/`    | proxy.golang.org |

在 workflow 的 step `env` 块中注入（只需在本插件步骤生效，不污染其他步骤）：

```yaml
jobs:
  pre-commit:
    steps:
      - name: run pre-commit
        uses: openlibing/pre-commit-action@v1.1.0
        env:
          PIP_MIRROR_DEFAULT: https://mirrors.huaweicloud.com/repository/pypi/simple
          GO_PROXY_DEFAULT: https://mirrors.huaweicloud.com/repository/goproxy/
```

配置后插件会先测速：镜像可达且更快时使用镜像，镜像不可达时自动回退官方源（不会因镜像故障而失败）。

## 报告生成与上传编排

本插件只负责**生成/收集 SARIF 报告文件**，不做上传回调。需要归档扫描结果到 openlibing 时，在 workflow 中串接 **openlibing-upload-sarif** 完成 OBS 上传与后端回调。

### 报告契约

1. 各工具钩子把原始报告（JSON 等）输出到约定目录（默认 `/tmp/pre-commit-reports/`，input `report-dir` 可覆盖）
2. 业务仓将原始报告转换为 SARIF 2.1.0，文件名 `<tool>.sarif` 写入同一约定目录（或通过 `sarif-file` input 直接指定）
3. 工具未提供报告且插件支持日志解析时，插件自动解析 pre-commit 日志兜底生成 `<tool>.sarif`
4. workflow 读取 `sarif-files` output，传给 openlibing-upload-sarif 的 `sarif-file` input 完成上传

### 串接示例

```yaml
# .gitcode/workflows/pre-commit-report.yml
on:
  workflow_dispatch:
permissions:
  repository: read
  id-token: write # OIDC 免密换证必需（openlibing-upload-sarif 换华为云临时凭证用）
jobs:
  pre-commit-report:
    runs-on: ["codearts-hosted", "ubuntu-latest", "x64", "slim"]
    steps:
      - name: Checkout repository
        uses: checkout
      - name: setup-python
        uses: setup-python
        with:
          version: 3.14
          cache: true
      - name: run pre-commit (generate sarif)
        id: pre-commit
        uses: openlibing/pre-commit-action@v1.1.0
        with:
          report-dir: /tmp/pre-commit-reports/
      - name: upload sarif reports
        uses: openlibing/openlibing-upload-sarif@v1.2.10
        with:
          sarif-file: ${{ steps.pre-commit.outputs.sarif-files }}
```

### 行为说明

- **PR 类型触发**（mr / pull_request / note）只做门禁检查，**不生成/收集 SARIF 报告**（门禁失败仍按 `exit(1)` 退出）；报告由版本级触发（push / workflow_dispatch / schedule）时产出，上传由 workflow 按需编排
- **检查失败仍生成报告**：pre-commit 失败时已生成的报告照常产出。**版本级触发**（push / workflow_dispatch / schedule）检查发现告警仅告警提示，**不按失败退出**；仅 PR 门禁场景按失败退出
- **钩子安装/环境失败按失败退出**：区分"检查出告警"与"钩子安装/环境失败"——钩子正常运行但发现问题（输出含标准 `xxx....Failed` 状态行）按上述门禁/版本级规则处理；钩子安装失败（hook 仓库拉取失败、依赖安装失败、spawn 失败等，输出含 `An unexpected error has occurred` 或无法解析出失败钩子状态行）**任何场景都按失败退出**，不属于"版本级告警不失败"范畴
- **数据源优先级**：① 输入 `sarif-file` 指定的文件/目录（支持逗号多值）；② 报告目录 `report-dir` 下已有的 `*.sarif`；③ 均无且日志有失败钩子时走兜底能力。同一工具已提供报告则直接使用，不再日志解析
- **兜底能力**：按工具维度处理失败钩子的报告。每个失败钩子：① 用户已提供该工具的 `*.sarif` → 直接使用；② 未提供且工具在支持解析列表（第一批：**clang-tidy / bandit / gosec / spotbugs / rust-clippy / eslint / gitleaks / detect-secrets**）→ 解析日志出具体问题（文件/行/列/规则/级别）生成 `<tool>.sarif`；③ 未提供且不支持 → 不生成报告，仅提示"`<工具> 未查询到 sarif 文件，且暂不支持日志自动解析"。日志无失败钩子则跳过生成

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
        with:
          fetch-depth: 0 # 推荐：全量检出才会生成 origin/<目标分支> 基线 ref，避免走 gc_token 兼容路径

      - name: setup-python
        uses: setup-python
        with:
          python-version: "3.14"

      - name: run pre-commit
        uses: openlibing/pre-commit-action@v1.1.0
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

  # ❌ GitHub 仓库 — detect-secrets 敏感信息扫描，需要自定义执行机
  # 安装说明：纯 Python，pip 安装（网络要求低）；首次使用需生成 baseline：detect-secrets scan > .secrets.baseline
  - repo: https://github.com/Yelp/detect-secrets
    rev: v1.5.0
    hooks:
      - id: detect-secrets
        args: ["--baseline", ".secrets.baseline"]
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
        with:
          fetch-depth: 0 # 推荐：全量检出才会生成 origin/<目标分支> 基线 ref，避免走 gc_token 兼容路径

      - name: setup-python
        uses: setup-python
        with:
          python-version: "3.14"

      - name: run pre-commit
        uses: openlibing/pre-commit-action@v1.1.0
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

  # ✅ GitCode 镜像仓 — detect-secrets 敏感信息扫描，国内网络可使用镜像仓加速下载
  # 安装说明：纯 Python，pip 安装（网络要求低）；首次使用需生成 baseline：detect-secrets scan > .secrets.baseline
  - repo: https://gitcode.com/gh_mirrors/de/detect-secrets
    rev: v1.5.0
    hooks:
      - id: detect-secrets
        args: ["--baseline", ".secrets.baseline"]
```

> **判断依据**：hooks 的 `repo` 地址以 `https://gitcode.com/` 开头的是 GitCode 镜像仓，云端执行机可直接访问；以 `https://github.com/` 或其他外部地址开头的，需要使用自定义执行机。

## 注意事项

- 运行前需先使用 `checkout` 检出代码；PR 增量检查推荐配置 `fetch-depth: 0`（浅检出不生成基线 ref，将回退 `git fetch`：传 `gc_token` 走兼容认证路径，否则依赖 checkout 持久化凭证，通常不可用）
- 运行前需先使用 `setup-python` 配置 Python 环境
- 项目根目录需包含 `.pre-commit-config.yaml` 配置文件
- PR 增量检查依赖 `ATOMGIT_BASE_REF` 和 `ATOMGIT_HEAD_REF` 环境变量
- **强烈建议配置 `PIP_MIRROR_DEFAULT` / `GO_PROXY_DEFAULT` 环境变量**（见「环境变量」章节）：未配置时回退 PyPI / Go 官方源，慢网/内网 runner 下钩子依赖安装可能耗时数分钟甚至超时
