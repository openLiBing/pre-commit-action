const { execSync, execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ObsClient = require('esdk-obs-nodejs');
const { callApig, configure, getCredentials } = require('@openlibing/huaweicloud-oidc-client');
const { buildToolSarif, matchToolParser } = require('./tool-parsers');

const PIP_MIRROR_DEFAULT = 'https://mirrors.huaweicloud.com/repository/pypi/simple';
const GO_PROXY_DEFAULT = 'https://mirrors.huaweicloud.com/repository/goproxy/';
const PIP_ORIGINAL = 'https://pypi.org/simple';
const GO_PROXY_ORIGINAL = 'https://proxy.golang.org/';
const SPEED_TEST_TIMEOUT = 5;
let PIP_MIRROR = '';
let GO_PROXY = '';
const PIP_TIMEOUT = '120';

// 报告扫描上传相关常量
const REPORT_DIR_DEFAULT = '/tmp/pre-commit-reports/'; // 各工具扫描报告约定目录（机器临时目录）
const OBS_BUCKET = 'openlibing-gitcode-action'; // openlibing 账号固定 OBS 桶（公网匿名可读）
const OBS_KEY_PREFIX = 'pre-commit-reports'; // 与 CodeArts 结果前缀 code-arts-check-results 区分
const OBS_READ_ENDPOINT = 'https://openlibing-gitcode-action.obs.cn-southwest-2.myhuaweicloud.com';
// APIG 回调地址必须使用 /action-api 前缀（网关 IAM 认证，V11 签名 + X-Security-Token）。
// 注意：/openlibing-codecheck 前缀是 APP 认证分组（upload-sarif 用 AppKey/AppSecret HMAC），
// 对 V11 IAM 签名返回 401，不得混用。与 openlibing-spotbugs-action / openlibing-codecheck-to-sarif 保持一致。
const APIG_CALLBACK_URL = 'https://apig.openlibing.com/action-api/codescan/v1/result/receive';
const APIG_CALLBACK_URL_BETA = 'https://174e1b821a8446f38998a67186ba766e.apic.cn-southwest-2.huaweicloudapis.com/action-api/codescan/v1/result/receive';
const APIG_CALLBACK_CATEGORY = 'pre-commit';

function getInput(name) {
  // 兼容连字符与下划线两种命名：report-dir 同时支持 INPUT_REPORT-DIR / INPUT_REPORT_DIR
  const dashKey = `INPUT_${name.toUpperCase().replace(/-/g, '-')}`;
  const underscoreKey = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  const val = process.env[dashKey] || process.env[underscoreKey] || '';
  const trimmed = val.trim();

  if (name === 'extra_args' && trimmed) {
    const allowedArgs = ['--all', '--all-files', '--help', '--show-diff-on-failure'];
    const args = trimmed.split(' ');
    for (const arg of args) {
      if (!allowedArgs.includes(arg) && !arg.startsWith('--')) {
        console.log(`[ERROR] Invalid extra_args: ${arg}. Only -- arguments are allowed.`);
        process.exit(1);
      }
    }
  }

  return trimmed;
}

function exec(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });
}

function execFile(cmd, args, options = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: options.cwd });
}

function sanitizePath(pathStr) {
  return pathStr.replace(/(\d+\.\d+\.\d+\.\d+)/g, '[IP_ADDRESS]');
}

function execCapture(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', shell: '/bin/bash' }).trim();
  } catch (e) {
    return '';
  }
}

function testUrlSpeed(url) {
  const result = execCapture(`curl -s -o /dev/null -w "%{time_total}" --max-time ${SPEED_TEST_TIMEOUT} "${url}" 2>/dev/null`);
  if (!result) return -1;
  const seconds = parseFloat(result);
  if (isNaN(seconds) || seconds <= 0) return -1;
  return Math.round(seconds * 1000);
}

function detectMirrorConfig() {
  console.log('[INFO] 开始网络测速，选择最快的源...');

  const pipOriginalMs = testUrlSpeed(PIP_ORIGINAL);
  const pipMirrorMs = testUrlSpeed(PIP_MIRROR_DEFAULT);

  console.log(`[INFO] PyPI 源站 (${PIP_ORIGINAL}) 响应: ${pipOriginalMs >= 0 ? pipOriginalMs + 'ms' : '超时/不可达'}`);
  console.log(`[INFO] 华为镜像 (${PIP_MIRROR_DEFAULT}) 响应: ${pipMirrorMs >= 0 ? pipMirrorMs + 'ms' : '超时/不可达'}`);

  if (pipOriginalMs < 0 && pipMirrorMs < 0) {
    PIP_MIRROR = PIP_ORIGINAL;
    console.log('[WARN] PyPI 源站和镜像均不可达，默认使用源站');
  } else if (pipOriginalMs < 0) {
    PIP_MIRROR = PIP_MIRROR_DEFAULT;
    console.log('[INFO] PyPI 源站不可达，使用华为镜像');
  } else if (pipMirrorMs < 0) {
    PIP_MIRROR = PIP_ORIGINAL;
    console.log('[INFO] 华为镜像不可达，使用 PyPI 源站');
  } else if (pipOriginalMs <= pipMirrorMs) {
    PIP_MIRROR = PIP_ORIGINAL;
    console.log(`[OK] PyPI 源站更快 (${pipOriginalMs}ms <= ${pipMirrorMs}ms)，使用源站`);
  } else {
    PIP_MIRROR = PIP_MIRROR_DEFAULT;
    console.log(`[OK] 华为镜像更快 (${pipMirrorMs}ms < ${pipOriginalMs}ms)，使用镜像`);
  }

  const goVersion = execCapture('go version');
  if (goVersion) {
    const goOriginalMs = testUrlSpeed(GO_PROXY_ORIGINAL);
    const goMirrorMs = testUrlSpeed(GO_PROXY_DEFAULT);

    console.log(`[INFO] Go 源站 (${GO_PROXY_ORIGINAL}) 响应: ${goOriginalMs >= 0 ? goOriginalMs + 'ms' : '超时/不可达'}`);
    console.log(`[INFO] 华为镜像 (${GO_PROXY_DEFAULT}) 响应: ${goMirrorMs >= 0 ? goMirrorMs + 'ms' : '超时/不可达'}`);

    if (goOriginalMs < 0 && goMirrorMs < 0) {
      GO_PROXY = GO_PROXY_ORIGINAL;
      console.log('[WARN] Go 源站和镜像均不可达，默认使用源站');
    } else if (goOriginalMs < 0) {
      GO_PROXY = GO_PROXY_DEFAULT;
      console.log('[INFO] Go 源站不可达，使用华为镜像');
    } else if (goMirrorMs < 0) {
      GO_PROXY = GO_PROXY_ORIGINAL;
      console.log('[INFO] 华为镜像不可达，使用 Go 源站');
    } else if (goOriginalMs <= goMirrorMs) {
      GO_PROXY = GO_PROXY_ORIGINAL;
      console.log(`[OK] Go 源站更快 (${goOriginalMs}ms <= ${goMirrorMs}ms)，使用源站`);
    } else {
      GO_PROXY = GO_PROXY_DEFAULT;
      console.log(`[OK] 华为镜像更快 (${goMirrorMs}ms < ${goOriginalMs}ms)，使用镜像`);
    }
  } else {
    GO_PROXY = GO_PROXY_DEFAULT;
    console.log('[INFO] Go 未安装，跳过 Go 代理测速');
  }
}

function buildAutoArgs() {
  const eventName = (process.env.ATOMGIT_EVENT_NAME || '').toLowerCase();
  const baseRef = process.env.ATOMGIT_BASE_REF || '';
  console.log(`[INFO] 当前事件: ${eventName || '(未知)'}, 目标分支: ${baseRef || '(无)'}`);

  if ((eventName === 'mr' || eventName === 'pull_request' || eventName === 'note') && baseRef) {
    console.log(`[INFO] 检测到 PR 事件，目标分支: ${baseRef}`);

    const token = getInput('gc_token');
    if (token) {
      const remoteUrl = execCapture('git remote get-url origin');
      if (remoteUrl && remoteUrl.startsWith('https://')) {
        const encodedToken = encodeURIComponent(token);
        const authUrl = remoteUrl.replace('https://', `https://oauth2:${encodedToken}@`);
        execCapture(`git remote set-url origin "${authUrl}"`);
      }
    }

    console.log(`[INFO] 拉取目标分支 origin/${baseRef} 以获取增量文件`);
    execFile('git', ['fetch', 'origin', baseRef]);

    const diffFilesOutput = execFileSync('git', ['diff', 'FETCH_HEAD', '--name-only', '--diff-filter=ACMR'], { encoding: 'utf-8' });
    const files = diffFilesOutput.split('\n').filter(f => f.trim());
    if (files.length === 0) {
      console.log('[INFO] PR 无变更文件，跳过增量检查');
      return { type: 'skip' };
    }
    console.log(`[INFO] PR 增量文件 (${files.length} 个):`);
    files.forEach(f => console.log(`  - ${f}`));
    return { type: 'file', files: files };
  }

  console.log('[INFO] 非 PR 事件，使用 --all-files 检查全量文件');
  return { type: 'args', args: '--all-files' };
}

function runPreCommit(cmdResult) {
  if (cmdResult.type === 'skip') {
    console.log('[OK] 无需检查');
    return { failed: false, output: '' };
  }

  // 捕获 pre_commit run 的输出（stdout+stderr），用于用户未提供 SARIF 时的日志兜底解析；
  // 同时原样转发到控制台，不改变既有日志可见性。
  const runArgs = cmdResult.type === 'file'
    ? ['-m', 'pre_commit', 'run', '--files', ...cmdResult.files]
    : ['-m', 'pre_commit', 'run', ...cmdResult.args.split(' ')];
  console.log(`> python ${runArgs.join(' ')}`);

  const sp = spawnSync('python', runArgs, { encoding: 'utf-8', cwd: process.cwd() });
  const output = (sp.stdout || '') + (sp.stderr || '');
  if (sp.stdout) process.stdout.write(sp.stdout);
  if (sp.stderr) process.stderr.write(sp.stderr);

  const checkFailed = sp.status !== 0;
  if (checkFailed) {
    console.log('[ERROR] pre-commit 检查失败');
    console.log('\n[INFO] 请在本地执行以下命令修复后重新提交:');
    console.log('1. 安装/初始化环境');
    console.log('   pip install pre-commit && pre-commit install --install-hooks');
    console.log('2. 检查并修复变更文件');
    if (cmdResult.type === 'file') {
      console.log(`   pre-commit run --files ${cmdResult.files.join(' ')}`);
    } else {
      console.log('   pre-commit run --all-files');
    }
    console.log('\n如需了解更多告警屏蔽、pre-commit配置等信息，请查阅: https://gitcode.com/openlibing/docs/blob/main/static-code-analysis/solutions/pre-commit-solution.md');
    // 不在此退出：pre-commit 失败时扫描报告同样有价值，报告上传完成后由 run() 统一按失败状态退出
    return { failed: true, output };
  }
  console.log('[OK] pre-commit 检查通过');
  console.log('如需了解更多告警屏蔽、pre-commit配置等信息，请查阅: https://gitcode.com/openlibing/docs/blob/main/static-code-analysis/solutions/pre-commit-solution.md');
  return { failed: false, output };
}

/** sha256 hex，用于兜底 SARIF 指纹（后端 StandardSarifParser 用 partialFingerprints.primaryLocationLineHash 构建 fingerprintKey）。 */
function _locationHash(parts) {
  const raw = parts.map((p) => (p === undefined || p === null ? '' : String(p))).join('|');
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** 解析 pre-commit 运行日志，提取失败的钩子（兜底 SARIF 数据源）。
 * pre-commit 标准输出格式：
 *   trailing whitespace.................................................Failed
 *   - hook id: trailing-whitespace
 *   - exit code: 1
 *
 *     Files were modified by this hook. Additional output:
 *
 *     src/foo.py
 *   detect-secrets-report................................................Passed
 * @returns {Array<{hookId: string, exitCode: (number|null), message: string, files: string[]}>}
 */
function parsePreCommitLog(output) {
  const failures = [];
  const lines = String(output || '').split('\n');
  // hook id 可能含空格（如 "trailing whitespace"），非贪婪捕获 + 至少 3 个点分隔状态
  const hookLineRe = /^(.+?)\s*\.{3,}\s*(Failed|Passed)\s*$/;
  // 疑似文件路径：单 token，可带 :line / :line:col 后缀（flake8/eslint 等 "path:1:1: msg" 只取 path 段）
  const pathLikeRe = /^[^\s:=]+$/;

  let current = null;      // 当前失败的钩子
  let collecting = false;  // 是否在收集失败钩子的输出块

  for (const line of lines) {
    const m = line.match(hookLineRe);
    if (m) {
      if (m[2] === 'Failed') {
        current = { hookId: m[1].trim(), exitCode: null, message: '', files: [], lines: [] };
        failures.push(current);
      } else {
        current = null;
      }
      collecting = false;
      continue;
    }
    if (!current) continue;

    const hookIdMatch = line.match(/^-\s*hook id:\s*(\S+)/);
    if (hookIdMatch) {
      current.hookId = hookIdMatch[1];
      collecting = true;
      continue;
    }
    const exitMatch = line.match(/^-\s*exit code:\s*(\d+)/);
    if (exitMatch) {
      current.exitCode = parseInt(exitMatch[1], 10);
      continue;
    }
    if (!collecting) continue;

    const trimmed = line.trim();
    if (!trimmed || /^-{3,}$/.test(trimmed)) continue;
    // 跳过 " - xxx" 元信息行（"- hook id"/"- exit code" 已在上方处理）；但 "--> path:line:col"
    // 是 rust-clippy 的位置行，以 "-" 开头但属有效输出，需保留
    if (/^-\s*\S/.test(trimmed) && !trimmed.startsWith('-->')) continue;
    // 收集输出块原始行（供按工具解析器使用）
    current.lines.push(trimmed);
    // detect-secrets 输出 "Filename: .env" → 提取文件（行可能带前导空格，用 trimmed 匹配）
    const fnMatch = trimmed.match(/^Filename:\s*(\S+)/);
    if (fnMatch) {
      if (current.files.length < 50) current.files.push(fnMatch[1]);
      continue;
    }
    // "Files were modified by this hook." / "Additional output:" 等说明行不作为文件，但可作 message 上下文
    if (pathLikeRe.test(trimmed) && !/^(Files|Additional|All|Total|skipping|Skipping)/i.test(trimmed)) {
      if (current.files.length < 50) current.files.push(trimmed);
    } else if (current.message.length === 0) {
      current.message = trimmed.slice(0, 300);
    }
  }
  return failures;
}

/** 由 pre-commit 运行日志按工具维度补齐兜底 SARIF 文件，写入报告目录。
 * 每个失败钩子按规则处理：
 *   1. 用户已提供该工具 sarif 文件（报告目录中存在 <tool>.sarif）→ 直接使用，跳过日志解析
 *   2. 未提供，且工具在支持列表（第一批：clang-tidy/bandit/gosec/spotbugs/rust-clippy/eslint/gitleaks/detect-secrets）
 *      → 解析日志生成 <tool>.sarif
 *   3. 未提供且不支持 → 不生成报告，仅提示 "<工具> 工具未查询到 sarif 文件，且暂不支持日志自动解析"
 * @param {string} preCommitOutput pre_commit run 的捕获输出（stdout+stderr）
 * @param {string[]} [existingSarifNames] 报告目录中已有的 *.sarif 文件名（用户提供的报告）
 * @returns {string[]} 新生成的兜底文件名数组（可能为空） */
function generateFallbackSarif(preCommitOutput, existingSarifNames) {
  const failures = parsePreCommitLog(preCommitOutput);
  if (failures.length === 0) return [];
  console.log(`[INFO] pre-commit 日志解析到 ${failures.length} 个失败钩子: ${failures.map(f => f.hookId).join(', ')}`);

  const reportDir = getInput('report-dir') || REPORT_DIR_DEFAULT;
  // 报告目录可能不存在（纯拦截钩子不生成报告），兜底生成前确保目录可写
  fs.mkdirSync(reportDir, { recursive: true });
  const generated = [];

  // 用户已提供的 sarif 文件名集合（小写），用于判断"该工具用户是否已输出 sarif"
  const existing = new Set((existingSarifNames || []).map(n => String(n).toLowerCase()));

  const writeSarif = (name, sarifObj) => {
    try {
      fs.writeFileSync(path.join(reportDir, name), JSON.stringify(sarifObj, null, 2), 'utf-8');
      generated.push(name);
      return true;
    } catch (e) {
      console.log(`[WARN] 生成兜底 SARIF 写入失败 (${name}): ${e.message}`);
      return false;
    }
  };

  for (const f of failures) {
    const parser = matchToolParser(f.hookId);
    const toolName = parser ? parser.toolName : String(f.hookId || '').toLowerCase();
    // 规则1：该工具用户已输出 sarif → 直接使用，跳过日志解析
    if (existing.has(`${toolName}.sarif`)) {
      console.log(`[INFO] ${toolName} 已提供 sarif 文件，直接使用: ${toolName}.sarif`);
      continue;
    }
    // 规则2：支持日志解析的工具 → 解析日志生成 <tool>.sarif
    if (parser) {
      const findings = parser.parse(f.lines || []);
      const sarifObj = buildToolSarif(parser.toolName, findings);
      if (sarifObj) {
        const name = `${parser.toolName}.sarif`;
        if (writeSarif(name, sarifObj)) {
          console.log(`[INFO] 已按 ${parser.toolName} 解析日志生成兜底 SARIF（${findings.length} 条问题）: ${name}`);
        }
      } else {
        console.log(`[WARN] ${parser.toolName} 日志中未解析到可识别的问题条目`);
      }
    } else {
      // 规则3：未提供 sarif 且不支持日志解析 → 仅提示
      console.log(`[WARN] ${toolName} 工具未查询到 sarif 文件，且暂不支持日志自动解析`);
    }
  }
  return generated;
}

/** 是否为 PR 类型触发（PR 触发不进行报告扫描上传回调）。与 buildAutoArgs 的 PR 判断保持一致。 */
function isPrEvent() {
  const eventName = (process.env.ATOMGIT_EVENT_NAME || '').toLowerCase();
  const baseRef = process.env.ATOMGIT_BASE_REF || '';
  return (eventName === 'mr' || eventName === 'pull_request' || eventName === 'note') && baseRef;
}

/** 回调分支：MR 事件用目标分支（ATOMGIT_HEAD_REF），其他事件用当前 ref（ATOMGIT_REF_NAME）。
 * 与 openlibing-spotbugs-action 的 resolveBranch 保持一致，避免 workflow_dispatch 等非 MR
 * 事件下 ATOMGIT_HEAD_REF 为空导致后端校验失败（分支名不能为空）。 */
function resolveBranch() {
  const eventName = (process.env.ATOMGIT_EVENT_NAME || '').toLowerCase();
  return eventName === 'mr'
    ? (process.env.ATOMGIT_HEAD_REF || '')
    : (process.env.ATOMGIT_REF_NAME || '');
}

/** 扫描报告上传：SARIF 报告 → OBS → APIG 回调。优先上传业务仓转换好的 *.sarif（用户提供的报告）；
 * 若报告目录无 *.sarif，则解析 pre-commit 运行日志生成兜底 SARIF（防止用户未提供报告的场景）。
 * PR 类型触发跳过。@param {string} preCommitOutput pre_commit run 的捕获输出（stdout+stderr） */
async function uploadScanReports(preCommitOutput) {
  console.log('\n===== [7] 报告扫描上传（SARIF 报告 → OBS → APIG 回调） =====');

  if (isPrEvent()) {
    console.log('[INFO] PR 类型触发，按约定不进行报告扫描上传回调，跳过');
    return;
  }

  const reportDir = getInput('report-dir') || REPORT_DIR_DEFAULT;

  // 用户提供的报告：报告目录下已有的 *.sarif（业务仓转换好的，直接使用）
  const sarifFiles = [];
  if (fs.existsSync(reportDir)) {
    fs.readdirSync(reportDir)
      .filter(f => f.endsWith('.sarif'))
      .sort()
      .forEach(f => sarifFiles.push(f));
  } else {
    console.log(`[INFO] 报告目录不存在，尝试从 pre-commit 日志兜底生成: ${reportDir}`);
  }

  // 按工具维度补齐：失败钩子对应工具已有用户 sarif 直接用；
  // 未提供且支持日志解析则生成 <tool>.sarif；未提供且不支持则提示。
  const fallbackFiles = generateFallbackSarif(preCommitOutput, sarifFiles);
  if (fallbackFiles.length > 0) {
    fallbackFiles.forEach(f => sarifFiles.push(f));
    console.log('[INFO] 已根据 pre-commit 日志生成兜底 SARIF: ' + fallbackFiles.join(', '));
  }

  if (sarifFiles.length === 0) {
    console.log(`[INFO] 无 SARIF 报告可上传（失败钩子工具均未提供 sarif 且不支持日志解析），跳过报告上传: ${reportDir}`);
    return;
  }

  console.log(`[OK] 发现 ${sarifFiles.length} 个 SARIF 报告:`);
  sarifFiles.forEach(f => console.log(`  - ${f}`));

  const workflowRunId = process.env.ATOMGIT_RUN_ID || process.env.PIPELINE_RUN_ID || '';
  const repoName = process.env.ATOMGIT_REPOSITORY || '';
  const repoBaseName = repoName.split('/').pop() || 'unknown-repo';
  const objectKeyPrefix = `${OBS_KEY_PREFIX}/${repoBaseName}/${workflowRunId || 'manual'}`;

  const debugEnabled = getInput('debug') === 'true';
  const { region } = configure({ debug: debugEnabled });

  console.log(`\n===== [8] OIDC 换证并上传 OBS（${OBS_BUCKET}/${objectKeyPrefix}/） =====`);
  const cred = await getCredentials();
  const server = `https://obs.${region}.myhuaweicloud.com`;
  const client = new ObsClient({
    access_key_id: cred.accessKeyId,
    secret_access_key: cred.secretAccessKey,
    security_token: cred.securityToken,
    server
  });
  // esdk-obs-nodejs 的 initFactory 为 fire-and-forget（内部 await refresh 后才设置签名上下文），
  // 构造后立即 putObject 会读到 null signatureContext（Cannot read properties of null (reading 'signature')），
  // 此处让出一个微任务等待初始化完成。
  await Promise.resolve();

  const sarifUrls = [];
  try {
    for (const sf of sarifFiles) {
      const objectKey = `${objectKeyPrefix}/${sf}`;
      console.log(`[INFO] 上传 ${objectKey}`);
      // ACL: 'public-read'：后端 SarifParseServiceImpl 通过匿名 HTTP GET 下载，对象必须公共读
      const result = await client.putObject({ Bucket: OBS_BUCKET, Key: objectKey, SourceFile: path.join(reportDir, sf), ACL: 'public-read' });
      const msg = (result && result.CommonMsg) || {};
      if (!(msg.Status >= 200 && msg.Status < 300)) {
        throw new Error(`OBS upload failed (${msg.Status})${msg.Code ? ' [' + msg.Code + ']' : ''}: ${msg.Message || '未知错误'}`);
      }
      const sarifUrl = `${OBS_READ_ENDPOINT}/${objectKey}`;
      sarifUrls.push(sarifUrl);
      console.log(`[OK] 上传成功: ${sarifUrl}`);
    }
  } finally {
    await client.close();
  }

  console.log('\n===== [9] APIG 回调 openlibing 后端 =====');
  // 根据 env-type input 显式选择回调地址（prod 走正式域名，beta 走华为云 APIG 实例域名）
  const isBetaEnv = (getInput('env-type') || 'prod').toLowerCase() === 'beta';
  const finalCallbackUrl = isBetaEnv ? APIG_CALLBACK_URL_BETA : APIG_CALLBACK_URL;
  console.log(`[INFO] 环境类型: ${isBetaEnv ? 'beta (测试环境)' : 'prod (正式环境)'}`);
  const callbackPayload = {
    repoUrl: process.env.ATOMGIT_REPOSITORY_URL || '',
    pipelineId: process.env.ATOMGIT_PIPELINE_ID || '',
    pipelineName: process.env.PIPELINE_NAME || '',
    pipelineRunId: workflowRunId || '',
    branch: resolveBranch(),
    commitId: process.env.ATOMGIT_SHA || '',
    obsUrl: sarifUrls, // 后端 DTO 为 List<String>，必须传数组
    category: APIG_CALLBACK_CATEGORY,
    source: 'GITCODE_ACTION',
    sourceRunUrl: ''
  };
  try {
    const res = await callApig('POST', finalCallbackUrl, null, JSON.stringify(callbackPayload));
    console.log(`[INFO] 回调响应: HTTP ${res.status}`);
    const data = res.data;
    // 后端 GlobalExceptionHandler 对校验失败返回 HTTP 200 + DataResult{code:4010103}，
    // 业务失败需检查响应体 code 字段（200/0 视为成功），不能只看 HTTP 状态码
    const isBizOk = data && typeof data === 'object' && !('raw' in data) && (data.code === 200 || data.code === 0);
    if (res.status >= 200 && res.status < 300 && isBizOk) {
      console.log('[OK] APIG 回调发送成功');
    } else {
      const bizCode = data && typeof data === 'object' ? data.code : undefined;
      const respText = data && typeof data === 'object' && 'raw' in data
        ? data.raw
        : JSON.stringify(data || {});
      console.log(`[WARN] APIG 回调未成功：HTTP ${res.status}${bizCode !== undefined ? `，业务码 ${bizCode}` : ''}，响应: ${respText}`);
    }
    const resultViewUrl = isBetaEnv ? 'https://beta.openlibing.com/apps/codeCheck' : 'https://www.openlibing.com/apps/codeCheck';
    console.log(`[INFO] 查看上传结果解析: ${resultViewUrl}`);
  } catch (cbErr) {
    console.log(`[WARN] APIG 回调发送失败: ${cbErr.message}（OBS 上传已成功，不影响最终结果）`);
  }
}

async function run() {
  const extraArgs = getInput('extra_args');
  console.log('===== pre-commit-action 启动 =====');

  console.log('\n===== [1] 检查 Python 环境 =====');
  execFile('python', ['--version']);

  console.log('\n===== [2] 安装 pre-commit =====');
  detectMirrorConfig();
  execFile('python', ['-m', 'pip', 'config', 'set', 'global.index-url', PIP_MIRROR]);
  console.log('[INFO] 检查 Go 环境...');
  const goVersion = execCapture('go version');
  console.log(`[INFO] goVersion = "${goVersion}"`);
  if (goVersion) {
    execFile('go', ['env', '-w', 'GO111MODULE=on']);
    execFile('go', ['env', '-w', `GOPROXY=${GO_PROXY}`]);
    execFile('go', ['env', '-w', 'GONOSUMDB=*']);
  } else {
    console.log('[WARN] Go 未安装，跳过 Go 代理配置');
  }
  execFile('python', ['-m', 'pip', 'install', '--upgrade', 'pip', '--timeout', PIP_TIMEOUT]);
  execFile('python', ['-m', 'pip', 'install', 'pre-commit', '--timeout', PIP_TIMEOUT]);
  execFile('python', ['-m', 'pre_commit', '--version']);

  console.log('\n===== [3] 定位代码目录 =====');
  const workspace = process.env.WORKSPACE || process.cwd();

  if (!/^\/[\w\-\/.]+$/.test(workspace)) {
    console.log('[ERROR] Invalid workspace path');
    process.exit(1);
  }

  let repoPath = '';

  if (fs.existsSync(path.join(workspace, 'repo_workspace'))) {
    repoPath = path.join(workspace, 'repo_workspace');
    console.log(`[OK] 使用 repo_workspace: ${repoPath}`);
  } else {
    const gitDirOutput = execFileSync('find', [workspace, '-maxdepth', '3', '-name', '.git', '-type', 'd'], { encoding: 'utf-8' });
    const gitDir = gitDirOutput.trim().split('\n')[0];
    if (gitDir) {
      repoPath = path.dirname(gitDir);
      console.log(`[OK] 通过 .git 定位: ${repoPath}`);
    }
  }

  if (!repoPath || !fs.existsSync(repoPath)) {
    console.log('[ERROR] 无法确定代码目录');
    process.exit(1);
  }

  process.chdir(repoPath);
  console.log(`代码目录: ${process.cwd()}`);

  console.log('\n===== [4] 检查 .pre-commit-config.yaml =====');
  if (!fs.existsSync('.pre-commit-config.yaml')) {
    console.log('[INFO] 未找到 .pre-commit-config.yaml，跳过 pre-commit 检查');
    return;
  }
  console.log('[OK] 找到 .pre-commit-config.yaml');

  console.log('\n===== [5] 构建运行参数 =====');
  let cmdResult;
  if (extraArgs) {
    console.log(`[INFO] 检测到自定义参数: ${extraArgs}`);
    cmdResult = { type: 'args', args: extraArgs };
  } else {
    cmdResult = buildAutoArgs();
  }

  console.log('\n===== [6] 运行 pre-commit 检查 =====');
  const preCommitResult = runPreCommit(cmdResult);

  await uploadScanReports(preCommitResult.output);

  if (preCommitResult.failed) {
    console.log('[ERROR] pre-commit 检查失败，扫描报告已上传，任务按失败状态退出');
    process.exit(1);
  }
}

if (require.main === module) {
  run().catch(err => {
    const sanitizedMessage = sanitizePath(err.message);
    console.error(`Action 执行失败: ${sanitizedMessage}`);
    process.exit(1);
  });
}

module.exports = { run, parsePreCommitLog, generateFallbackSarif, _locationHash };
