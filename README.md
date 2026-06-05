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

```yaml
steps:
  - name: official_checkout
    uses: official_checkout

  - name: setup-python
    uses: setup-python

  - name: run pre-commit
    uses: openlibing-pre-commit-action
```

## 注意事项

- 运行前需先使用 `official_checkout` 检出代码
- 运行前需先使用 `setup-python` 配置 Python 环境
- 项目根目录需包含 `.pre-commit-config.yaml` 配置文件
- PR 增量检查依赖 `ATOMGIT_BASE_REF` 和 `ATOMGIT_HEAD_REF` 环境变量
