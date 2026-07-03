# openlibing-pre-commit-action 深度安全审计报告

## 审计概述

| 项目 | 详情 |
|------|------|
| 项目名称 | openlibing-pre-commit-action |
| 项目路径 | E:\work\huawei\fork\openlibing-pre-commit-action |
| 审计模式 | 深度审计 |
| 审计范围 | 注入类漏洞、命令执行类漏洞 |
| 审计日期 | 2026-07-03 |
| 技术栈 | Node.js (CommonJS) + Shell Script |

---

## 漏洞汇总

### 严重级别统计

| 级别 | 数量 |
|------|------|
| 高危 | 9 |
| 中危 | 3 |
| 低危 | 2 |

---

## 详细漏洞报告

### 1. 命令注入漏洞：extra_args 参数未验证（高危）

**漏洞编号**: CMD-001

**漏洞类型**: 命令执行类 - Shell 命令注入

**严重级别**: 高危

**影响文件**:
- `index.js` (第322-324行, 第206行)

**漏洞描述**:

`extra_args` 参数从用户输入获取后，直接传递给 `exec()` 函数执行，没有进行任何验证或转义。

```javascript
const extraArgs = getInput('extra_args');
// ...
if (extraArgs) {
  console.log(`[INFO] 检测到自定义参数: ${extraArgs}`);
  cmdResult = { type: 'args', args: extraArgs };
}
// ...
exec(`python -m pre_commit run ${cmdResult.args}`);
```

**攻击原理**:

攻击者可以通过 `extra_args` 参数注入任意 shell 命令。例如：

```yaml
extra_args: "--all; rm -rf /"
```

这会导致以下命令被执行：
```bash
python -m pre_commit run --all; rm -rf /
```

**风险评估**:

这是一个严重的命令注入漏洞，攻击者可以：
- 执行任意系统命令
- 删除系统文件
- 获取敏感信息
- 权限提升
- 容器逃逸

**修复建议**:

1. 使用白名单限制允许的参数
2. 对用户输入进行严格验证
3. 使用参数化方式执行命令

```javascript
const allowedArgs = ['--all', '--all-files', '--help'];

function validateExtraArgs(args) {
  const parts = args.trim().split(' ');
  for (const part of parts) {
    if (!allowedArgs.includes(part) && !part.startsWith('--')) {
      throw new Error(`Invalid argument: ${part}`);
    }
  }
  return args;
}

// 使用 execFile 替代 exec
const { execFile } = require('child_process');

// 在 runPreCommit 中
execFile('python', ['-m', 'pre_commit', 'run', ...cmdResult.args.split(' ')], (err, stdout, stderr) => {
  // ...
});
```

---

### 2. 命令注入漏洞：USER.login 未验证（高危）

**漏洞编号**: CMD-002

**漏洞类型**: 命令执行类 - Shell 命令注入

**严重级别**: 高危

**影响文件**:
- `index.js` (第137-144行, 第164-165行, 第252-253行)

**漏洞描述**:

`USER.login` 和 `USER.email` 从 API 响应中获取后，直接拼接到 git 命令中执行，没有进行验证。

```javascript
const output = execCapture(`curl -s --max-time 10 'https://${host}/api/v5/user' --header 'PRIVATE-TOKEN: ${GC_TOKEN}'`);
if (output) {
  const resp = JSON.parse(output);
  const login = resp.login || resp.name || USER.login;
  const email = resp.email || USER.email;
  USER.login = login;
  USER.email = email;
}
```

然后这些值被直接用于 git 命令：

```javascript
exec(`git config user.name ${USER.login}`);
exec(`git config user.email ${USER.email}`);
// ...
exec(`cd "${randDir}" && git config user.name ${USER.login}`);
exec(`cd "${randDir}" && git config user.email ${USER.email}`);
```

**攻击原理**:

如果攻击者能够控制 API 响应（通过 SSRF 或其他方式），可以返回恶意的 `login` 或 `email` 值：

```json
{
  "login": "attacker'; rm -rf /; echo '",
  "email": "attacker@example.com"
}
```

这会导致以下命令被执行：
```bash
git config user.name attacker'; rm -rf /; echo '
```

**风险评估**:

攻击者可以通过控制用户信息执行任意命令，导致：
- 系统文件删除
- 权限提升
- 容器逃逸
- 数据泄露

**修复建议**:

1. 对从 API 获取的用户信息进行严格验证
2. 使用参数化方式执行 git 命令
3. 限制用户信息的长度和字符集

```javascript
// 验证用户信息
function sanitizeGitConfig(value) {
  if (!value) return value;
  // 只允许字母、数字、下划线、连字符、点号和空格
  const sanitized = value.replace(/[^a-zA-Z0-9_\-\.@ ]/g, '');
  return sanitized;
}

USER.login = sanitizeGitConfig(resp.login || resp.name || USER.login);
USER.email = sanitizeGitConfig(resp.email || USER.email);

// 使用参数化方式执行命令
execFile('git', ['config', 'user.name', USER.login]);
execFile('git', ['config', 'user.email', USER.email]);
```

---

### 3. 命令注入漏洞：MERGE_REQUEST_IID 未验证（高危）

**漏洞编号**: CMD-003

**漏洞类型**: 命令执行类 - Shell 命令注入

**严重级别**: 高危

**影响文件**:
- `index.js` (第166-175行)

**漏洞描述**:

`MERGE_REQUEST_IID` 环境变量直接拼接到 git 命令中执行，没有进行验证。

```javascript
exec(`git fetch origin refs/merge-requests/${process.env.MERGE_REQUEST_IID}/head:pr_${process.env.MERGE_REQUEST_IID}`);
exec(`git fetch origin ${baseRef} --unshallow`);
exec(`git checkout pr_${process.env.MERGE_REQUEST_IID}`);
exec(`git merge origin/${baseRef} --no-edit`);
let diffFiles = execCapture(`git diff ${baseRef}...pr_${process.env.MERGE_REQUEST_IID} --name-only --diff-filter=ACMR`);
```

**攻击原理**:

如果攻击者能够控制 `MERGE_REQUEST_IID` 环境变量，可以注入恶意命令：

```
MERGE_REQUEST_IID=1; rm -rf /; echo
```

这会导致以下命令被执行：
```bash
git fetch origin refs/merge-requests/1; rm -rf /; echo/head:pr_1; rm -rf /; echo
```

**风险评估**:

攻击者可以通过控制环境变量执行任意命令，导致：
- 系统文件删除
- 权限提升
- 容器逃逸

**修复建议**:

1. 对 `MERGE_REQUEST_IID` 进行数字验证
2. 使用参数化方式执行命令

```javascript
const mergeRequestIid = process.env.MERGE_REQUEST_IID;

// 验证 MERGE_REQUEST_IID 必须是数字
if (!/^\d+$/.test(mergeRequestIid)) {
  console.log('[ERROR] Invalid MERGE_REQUEST_IID');
  process.exit(1);
}

// 使用参数化方式执行命令
execFile('git', ['fetch', 'origin', `refs/merge-requests/${mergeRequestIid}/head:pr_${mergeRequestIid}`]);
execFile('git', ['checkout', `pr_${mergeRequestIid}`]);
```

---

### 4. 命令注入漏洞：forkUrl 未验证（高危）

**漏洞编号**: CMD-004

**漏洞类型**: 命令执行类 - Shell 命令注入

**严重级别**: 高危

**影响文件**:
- `index.js` (第241-248行)

**漏洞描述**:

`forkUrl` 从 webhook payload 中解析后，直接拼接到 `git clone` 命令中执行，没有进行验证。

```javascript
const webhook = JSON.parse(process.env.WEBHOOK_PAYLOAD);
let forkUrl = webhook.merge_request.source.git_http_url;
if (GC_TOKEN) {
  forkUrl = forkUrl.replace('https://', `https://oauth2:${GC_TOKEN}@`);
}
exec(`git clone -b "${process.env.ATOMGIT_HEAD_REF}" "${forkUrl}" "${randDir}"`);
```

**攻击原理**:

如果攻击者能够控制 webhook payload，可以构造恶意的 `git_http_url`：

```json
{
  "merge_request": {
    "source": {
      "git_http_url": "https://github.com/attacker/repo.git"; rm -rf /; echo "
    }
  }
}
```

这会导致以下命令被执行：
```bash
git clone -b "main" "https://github.com/attacker/repo.git"; rm -rf /; echo "" "/tmp/repo-xxx"
```

**风险评估**:

攻击者可以通过控制 webhook payload 执行任意命令，导致：
- 系统文件删除
- 权限提升
- 容器逃逸
- 恶意代码下载和执行

**修复建议**:

1. 对 `forkUrl` 进行严格验证（协议、域名白名单）
2. 使用参数化方式执行命令
3. 验证 ATOMGIT_HEAD_REF

```javascript
const webhook = JSON.parse(process.env.WEBHOOK_PAYLOAD);
let forkUrl = webhook.merge_request.source.git_http_url;

// 验证 URL
const allowedHosts = ['github.com', 'gitcode.com', 'gitee.com'];
const parsedUrl = new URL(forkUrl);
if (!allowedHosts.includes(parsedUrl.hostname)) {
  console.log('[ERROR] Invalid repository host');
  process.exit(1);
}

// 验证分支名
const headRef = process.env.ATOMGIT_HEAD_REF;
if (!/^[a-zA-Z0-9_\-\/]+$/.test(headRef)) {
  console.log('[ERROR] Invalid branch name');
  process.exit(1);
}

// 使用参数化方式执行命令
execFile('git', ['clone', '-b', headRef, forkUrl, randDir]);
```

---

### 5. 命令注入漏洞：workspace 变量未验证（高危）

**漏洞编号**: CMD-005

**漏洞类型**: 命令执行类 - Shell 命令注入

**严重级别**: 高危

**影响文件**:
- `index.js` (第288-300行)

**漏洞描述**:

`workspace` 环境变量直接拼接到 `find` 命令中执行，没有进行验证。

```javascript
const workspace = process.env.WORKSPACE || process.cwd();
// ...
const gitDir = execCapture(`find ${workspace} -maxdepth 3 -name ".git" -type d 2>/dev/null | head -1`);
```

**攻击原理**:

如果攻击者能够控制 `WORKSPACE` 环境变量，可以注入恶意命令：

```
WORKSPACE="/tmp; rm -rf /; echo"
```

这会导致以下命令被执行：
```bash
find /tmp; rm -rf /; echo -maxdepth 3 -name ".git" -type d 2>/dev/null | head -1
```

**风险评估**:

攻击者可以通过控制环境变量执行任意命令，导致：
- 系统文件删除
- 权限提升
- 容器逃逸

**修复建议**:

1. 对 `workspace` 进行路径验证
2. 使用参数化方式执行命令

```javascript
const workspace = process.env.WORKSPACE || process.cwd();

// 验证路径
if (!/^\/[\w\-\/]+$/.test(workspace)) {
  console.log('[ERROR] Invalid workspace path');
  process.exit(1);
}

// 使用参数化方式执行命令
execFile('find', [workspace, '-maxdepth', '3', '-name', '.git', '-type', 'd'], (err, stdout, stderr) => {
  const gitDir = stdout.trim().split('\n')[0];
  // ...
});
```

---

### 6. 命令注入漏洞：cp 命令中的 diffFile（高危）

**漏洞编号**: CMD-006

**漏洞类型**: 命令执行类 - Shell 命令注入

**严重级别**: 高危

**影响文件**:
- `index.js` (第249-251行)

**漏洞描述**:

`diffFile` 来自 git status 输出，直接拼接到 `cp` 命令中执行，没有进行验证或转义。

```javascript
for (let diffFile of diffFiles) {
  exec(`cp "${diffFile}" "${randDir}/${diffFile}"`);
}
```

**攻击原理**:

如果文件名包含双引号或反引号，攻击者可以突破引号限制执行任意命令。

例如，如果文件名是 `file"; rm -rf /; echo "`，命令会变成：
```bash
cp "file"; rm -rf /; echo "" "/tmp/repo-xxx/file"; rm -rf /; echo ""
```

**风险评估**:

攻击者可以通过创建恶意命名的文件执行任意命令，导致：
- 系统文件删除
- 权限提升
- 容器逃逸

**修复建议**:

1. 使用参数化方式执行 `cp` 命令
2. 对文件名进行严格验证

```javascript
// 使用参数化方式执行命令
const { copyFileSync } = require('fs');

for (let diffFile of diffFiles) {
  // 验证文件名
  if (!/^[\w\-\/\._]+$/.test(diffFile)) {
    console.log(`[WARN] Skipping invalid file: ${diffFile}`);
    continue;
  }
  copyFileSync(diffFile, path.join(randDir, diffFile));
}
```

---

### 7. 命令注入漏洞：ATOMGIT_BASE_REF 和 ATOMGIT_HEAD_REF（高危）

**漏洞编号**: CMD-007

**漏洞类型**: 命令执行类 - Shell 命令注入

**严重级别**: 高危

**影响文件**:
- `index.js` (第157-159行, 第167-175行)

**漏洞描述**:

`ATOMGIT_BASE_REF` 和 `ATOMGIT_HEAD_REF` 环境变量直接拼接到多个 git 命令中执行，没有进行验证。

```javascript
const eventName = (process.env.ATOMGIT_EVENT_NAME || '').toLowerCase();
const baseRef = process.env.ATOMGIT_BASE_REF || '';
const headRef = process.env.ATOMGIT_HEAD_REF || '';

if ((eventName === 'mr' || eventName === 'pull_request') && baseRef && headRef) {
  // ...
  exec(`git fetch origin ${baseRef} --unshallow`);
  exec(`git merge origin/${baseRef} --no-edit`);
  let diffFiles = execCapture(`git diff ${baseRef}...pr_${process.env.MERGE_REQUEST_IID} --name-only --diff-filter=ACMR`);
  // ...
}
```

**攻击原理**:

如果攻击者能够控制这些环境变量，可以注入恶意命令：

```
ATOMGIT_BASE_REF=main; rm -rf /; echo
```

这会导致以下命令被执行：
```bash
git fetch origin main; rm -rf /; echo --unshallow
```

**风险评估**:

攻击者可以通过控制环境变量执行任意命令，导致：
- 系统文件删除
- 权限提升
- 容器逃逸

**修复建议**:

1. 对分支名进行严格验证
2. 使用参数化方式执行命令

```javascript
const baseRef = process.env.ATOMGIT_BASE_REF || '';
const headRef = process.env.ATOMGIT_HEAD_REF || '';

// 验证分支名
const branchPattern = /^[a-zA-Z0-9_\-\/]+$/;
if (!branchPattern.test(baseRef) || !branchPattern.test(headRef)) {
  console.log('[ERROR] Invalid branch name');
  process.exit(1);
}

// 使用参数化方式执行命令
execFile('git', ['fetch', 'origin', baseRef, '--unshallow']);
execFile('git', ['merge', `origin/${baseRef}`, '--no-edit']);
```

---

### 8. 命令注入漏洞：ATOMGIT_REPOSITORY（高危）

**漏洞编号**: CMD-008

**漏洞类型**: 命令执行类 - Shell 命令注入

**严重级别**: 高危

**影响文件**:
- `index.js` (第242行, 第248行)

**漏洞描述**:

`ATOMGIT_REPOSITORY` 环境变量用于构造临时目录路径，并直接拼接到 `git clone` 命令中执行，没有进行验证。

```javascript
const randDir = path.join(os.tmpdir(), `${process.env.ATOMGIT_REPOSITORY}-${Date.now()}`);
exec(`git clone -b "${process.env.ATOMGIT_HEAD_REF}" "${forkUrl}" "${randDir}"`);
```

**攻击原理**:

如果攻击者能够控制 `ATOMGIT_REPOSITORY` 环境变量，可以注入恶意命令：

```
ATOMGIT_REPOSITORY=repo"; rm -rf /; echo "
```

这会导致以下命令被执行：
```bash
git clone -b "main" "https://github.com/repo.git" "/tmp/repo"; rm -rf /; echo "-1234567890"
```

**风险评估**:

攻击者可以通过控制环境变量执行任意命令，导致：
- 系统文件删除
- 权限提升
- 容器逃逸

**修复建议**:

1. 对 `ATOMGIT_REPOSITORY` 进行严格验证
2. 使用参数化方式执行命令

```javascript
const repoName = process.env.ATOMGIT_REPOSITORY || '';

// 验证仓库名
if (!/^[\w\-\/]+$/.test(repoName)) {
  console.log('[ERROR] Invalid repository name');
  process.exit(1);
}

const randDir = path.join(os.tmpdir(), `${repoName}-${Date.now()}`);

// 使用参数化方式执行命令
execFile('git', ['clone', '-b', headRef, forkUrl, randDir]);
```

---

### 9. SSRF 漏洞：GC_TOKEN 发送到外部 API（高危）

**漏洞编号**: INJ-001

**漏洞类型**: 注入类 - SSRF（服务端请求伪造）

**严重级别**: 高危

**影响文件**:
- `index.js` (第134-137行)

**漏洞描述**:

`GC_TOKEN` 被发送到外部 API 获取用户信息，主机名判断使用了 `includes()` 子字符串匹配，可以被绕过。

```javascript
const host = process.env.ATOMGIT_REPOSITORY_URL.includes('test.gitcode.net') ? 'test.gitcode.net' : 'api.gitcode.com';
const output = execCapture(`curl -s --max-time 10 'https://${host}/api/v5/user' --header 'PRIVATE-TOKEN: ${GC_TOKEN}'`);
```

**攻击原理**:

`includes('test.gitcode.net')` 是一个子字符串匹配，攻击者可以构造恶意 URL 绕过检查：

```
ATOMGIT_REPOSITORY_URL=https://evil.com/test.gitcode.net.payload
```

这会导致 `host` 被设置为 `test.gitcode.net`，但如果攻击者进一步控制 URL 构造逻辑，可能将请求发送到任意地址。

此外，如果 `ATOMGIT_REPOSITORY_URL` 包含其他域名，请求会被发送到 `api.gitcode.com`，但如果攻击者能够伪造 DNS 记录或使用其他攻击手段，仍然存在风险。

**风险评估**:

攻击者可以通过控制 `ATOMGIT_REPOSITORY_URL`：
- 将 `GC_TOKEN` 发送到恶意服务器
- 泄露敏感凭证
- 探测内网服务

**修复建议**:

1. 使用严格的正则表达式验证主机名，而不是 `includes()`
2. 使用白名单限制允许的主机名

```javascript
const repoUrl = process.env.ATOMGIT_REPOSITORY_URL;
const urlPattern = /^https?:\/\/([^\/]+)/;
const match = repoUrl.match(urlPattern);

if (!match) {
  console.log('[ERROR] Invalid repository URL');
  process.exit(1);
}

const hostname = match[1];
const allowedHosts = ['gitcode.net', 'test.gitcode.net', 'gitee.com'];

if (!allowedHosts.some(h => hostname.includes(h))) {
  console.log('[ERROR] Invalid repository host');
  process.exit(1);
}

let host = hostname.includes('test.gitcode.net') ? 'test.gitcode.net' : 'api.gitcode.com';

// 使用参数化方式执行 curl
execFile('curl', ['-s', '--max-time', '10', `https://${host}/api/v5/user`, '--header', `PRIVATE-TOKEN: ${GC_TOKEN}`]);
```

---

### 10. Token 泄露风险（中危）

**漏洞编号**: INJ-002

**漏洞类型**: 注入类 - 敏感信息泄露

**严重级别**: 中危

**影响文件**:
- `index.js` (第139行)

**漏洞描述**:

API 响应（可能包含敏感信息）被直接打印到控制台。

```javascript
const output = execCapture(`curl -s --max-time 10 'https://${host}/api/v5/user' --header 'PRIVATE-TOKEN: ${GC_TOKEN}'`);
if (output) {
  console.log(`output: ${output}`); // 此处泄露用户信息
  const resp = JSON.parse(output);
  // ...
}
```

**攻击原理**:

虽然代码中没有直接打印 `GC_TOKEN`，但 API 响应可能包含用户的敏感信息（如邮箱、个人信息等）。这些信息会被打印到控制台，可能被日志系统或 CI/CD 系统捕获并泄露。

**风险评估**:

敏感信息可能通过日志系统泄露，导致：
- 用户隐私泄露
- 账户信息暴露

**修复建议**:

1. 不要打印完整的 API 响应
2. 只打印必要的信息
3. 使用脱敏处理

```javascript
const output = execCapture(`curl -s --max-time 10 'https://${host}/api/v5/user' --header 'PRIVATE-TOKEN: ${GC_TOKEN}'`);
if (output) {
  try {
    const resp = JSON.parse(output);
    console.log(`[INFO] 获取用户信息成功: ${resp.login}`);
    USER.login = resp.login || resp.name || USER.login;
    USER.email = resp.email || USER.email;
  } catch (e) {
    console.log(`[ERROR] 解析用户信息失败`);
  }
}
```

---

### 11. 文件名解析问题（中危）

**漏洞编号**: CMD-009

**漏洞类型**: 命令执行类 - 文件名解析错误

**严重级别**: 中危

**影响文件**:
- `index.js` (第224行)

**漏洞描述**:

`git status --porcelain | awk '{print $2}'` 命令使用 awk 解析 git status 输出，但如果文件名包含空格，awk 会将文件名错误地分割成多个字段。

```javascript
const status = execCapture(`git status --porcelain | awk '{print $2}'`);
```

**问题分析**:

`git status --porcelain` 的输出格式为：
```
M  file name with spaces.txt
```

使用 `awk '{print $2}'` 只能获取到 `file`，而不是完整的文件名 `file name with spaces.txt`。

虽然这不是直接的命令注入漏洞，但错误的文件名解析可能导致：
- 文件复制失败或复制错误的文件
- 潜在的安全问题（如果后续使用错误的文件名）

**风险评估**:

文件名解析错误可能导致：
- 文件操作失败
- 数据丢失
- 潜在的安全隐患

**修复建议**:

1. 使用 git 命令的参数化输出
2. 使用 Node.js 解析 git status 输出

```javascript
// 使用参数化方式执行 git status
const statusOutput = execCapture('git status --porcelain');
const files = statusOutput.split('\n').filter(line => line.trim()).map(line => {
  return line.substring(3); // 获取第3个字符开始的文件名
});
```

---

### 12. 命令注入漏洞：diffFiles 数组拼接（中危）

**漏洞编号**: CMD-010

**漏洞类型**: 命令执行类 - Shell 命令注入

**严重级别**: 中危

**影响文件**:
- `index.js` (第195行)

**漏洞描述**:

`batchFiles` 数组直接通过 `join(' ')` 拼接后传递给命令，没有进行转义。

```javascript
exec(`python -m pre_commit run ${hook} --files ${batchFiles.join(' ')}`);
```

**攻击原理**:

如果文件名包含空格或特殊字符（如 `'`、`;`、`$`），可能导致命令注入。

例如，如果文件名是 `file.py'; rm -rf /; echo '`，命令会变成：
```bash
python -m pre_commit run clang-format --files file.py'; rm -rf /; echo '
```

**风险评估**:

攻击者可以通过创建恶意命名的文件执行任意命令，导致：
- 系统文件删除
- 权限提升

**修复建议**:

1. 使用参数化方式执行命令
2. 对文件名进行转义

```javascript
// 使用参数化方式执行命令
execFile('python', ['-m', 'pre_commit', 'run', hook, '--files', ...batchFiles]);
```

---

### 13. 不安全的 execSync 使用（低危）

**漏洞编号**: CMD-011

**漏洞类型**: 命令执行类 - 不安全命令执行

**严重级别**: 低危

**影响文件**:
- `index.js` (第24-27行)

**漏洞描述**:

`exec` 函数使用 `execSync` 执行命令，并将 `stdio` 设置为 `inherit`，这会将命令的输出直接传递给父进程的标准输出和标准错误。

```javascript
function exec(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });
}
```

**风险评估**:

虽然这本身不是命令注入漏洞，但将命令输出直接传递给父进程可能导致：
- 敏感信息泄露（如果命令输出包含敏感数据）
- 日志污染

**修复建议**:

1. 考虑使用更安全的命令执行方式
2. 对敏感命令的输出进行过滤

```javascript
function exec(cmd) {
  console.log(`> ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });
  } catch (e) {
    console.error(`[ERROR] Command failed: ${cmd}`);
    throw e;
  }
}
```

---

### 14. 缺少输入验证（低危）

**漏洞编号**: INJ-003

**漏洞类型**: 注入类 - 输入验证不足

**严重级别**: 低危

**影响文件**:
- `index.js` (第19-22行)

**漏洞描述**:

`getInput` 函数只对输入进行了简单的 `trim()` 处理，没有进行类型验证或长度限制。

```javascript
function getInput(name) {
  const val = process.env[`INPUT_${name.toUpperCase()}`] || '';
  return val.trim();
}
```

**风险评估**:

虽然这本身不是直接的漏洞，但缺乏输入验证可能导致：
- 意外的输入格式
- 潜在的拒绝服务（超长输入）

**修复建议**:

1. 添加输入验证和长度限制
2. 根据输入类型进行相应的验证

```javascript
function getInput(name, options = {}) {
  const val = process.env[`INPUT_${name.toUpperCase()}`] || '';
  const trimmed = val.trim();
  
  if (options.maxLength && trimmed.length > options.maxLength) {
    console.log(`[WARN] Input ${name} exceeds maximum length`);
    return trimmed.substring(0, options.maxLength);
  }
  
  if (options.pattern && !options.pattern.test(trimmed)) {
    console.log(`[WARN] Input ${name} does not match expected pattern`);
    return options.default || '';
  }
  
  return trimmed;
}
```

---

## 漏洞复核与去重

### 重复项检查

| 原始编号 | 重复编号 | 处理方式 |
|---------|---------|---------|
| 无 | 无 | 无重复项 |

### 最终漏洞列表

经过复核，以下为去重后的最终漏洞列表：

1. **CMD-001**: 命令注入漏洞：extra_args 参数未验证（高危）
2. **CMD-002**: 命令注入漏洞：USER.login 未验证（高危）
3. **CMD-003**: 命令注入漏洞：MERGE_REQUEST_IID 未验证（高危）
4. **CMD-004**: 命令注入漏洞：forkUrl 未验证（高危）
5. **CMD-005**: 命令注入漏洞：workspace 变量未验证（高危）
6. **CMD-006**: 命令注入漏洞：cp 命令中的 diffFile（高危）
7. **CMD-007**: 命令注入漏洞：ATOMGIT_BASE_REF 和 ATOMGIT_HEAD_REF（高危）
8. **CMD-008**: 命令注入漏洞：ATOMGIT_REPOSITORY（高危）
9. **INJ-001**: SSRF 漏洞：GC_TOKEN 发送到外部 API（高危）
10. **INJ-002**: Token 泄露风险（中危）
11. **CMD-009**: 文件名解析问题（中危）
12. **CMD-010**: 命令注入漏洞：diffFiles 数组拼接（中危）
13. **CMD-011**: 不安全的 execSync 使用（低危）
14. **INJ-003**: 缺少输入验证（低危）

---

## 修复优先级建议

| 优先级 | 漏洞编号 | 修复理由 |
|-------|---------|---------|
| P0 | CMD-001 | extra_args 直接执行，可导致任意命令执行 |
| P0 | CMD-002 | USER.login/email 未验证，可导致命令注入 |
| P0 | CMD-003 | MERGE_REQUEST_IID 未验证，可导致命令注入 |
| P0 | CMD-004 | forkUrl 未验证，可导致命令注入和恶意代码下载 |
| P0 | CMD-005 | workspace 未验证，可导致命令注入 |
| P0 | CMD-006 | cp 命令中 diffFile 未验证，可导致命令注入 |
| P0 | CMD-007 | ATOMGIT_BASE_REF/HEAD_REF 未验证，可导致命令注入 |
| P0 | CMD-008 | ATOMGIT_REPOSITORY 未验证，可导致命令注入 |
| P0 | INJ-001 | SSRF 可导致凭证泄露和内网探测，includes() 可被绕过 |
| P1 | INJ-002 | Token 泄露风险，可导致敏感信息暴露 |
| P1 | CMD-009 | 文件名解析问题，可导致文件操作错误 |
| P1 | CMD-010 | diffFiles 拼接可能导致命令注入 |
| P3 | CMD-011 | execSync 使用方式不够安全 |
| P3 | INJ-003 | 缺少输入验证，建议增强 |

---

## 审计结论

### 总体评价

`openlibing-pre-commit-action` 是一个 GitHub/GitCode Action 项目，用于执行 pre-commit 钩子检查。该项目存在严重的安全漏洞，主要集中在命令注入方面。几乎所有用户可控的输入都直接拼接到 shell 命令中执行，没有进行验证或转义。

### 主要风险

1. **命令注入**: 多个用户可控的输入直接拼接到 shell 命令中执行，没有进行验证或转义
2. **SSRF**: GC_TOKEN 被发送到外部 API，存在凭证泄露风险，且主机名判断使用了可被绕过的 `includes()`
3. **敏感信息泄露**: API 响应被直接打印到控制台
4. **文件名解析**: awk 命令无法正确处理包含空格的文件名

### 安全建议

1. **使用参数化命令执行**: 使用 `execFile` 替代 `exec`，将命令参数作为数组传递
2. **输入验证**: 对所有用户可控的输入进行严格验证（类型、长度、字符集）
3. **白名单限制**: 对 URL、分支名、主机名等使用白名单限制
4. **避免 includes() 子字符串匹配**: 使用严格的正则表达式验证
5. **脱敏处理**: 不要打印完整的 API 响应，只打印必要的信息
6. **安全编码**: 避免直接拼接字符串到 shell 命令中

---

**审计完成时间**: 2026-07-03
**审计人**: AI 安全审计系统
**版本**: 1.0