const { execSync, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { buildToolSarif, matchToolParser } = require('./tool-parsers');

// 镜像地址改为环境变量注入（PIP_MIRROR_DEFAULT / GO_PROXY_DEFAULT），源码不再硬编码第三方镜像公网地址；
// 未配置时回退到官方源。PIP_ORIGINAL / GO_PROXY_ORIGINAL 为官方源地址，属功能必需，登记白名单（合规例外）。
const PIP_MIRROR_DEFAULT = process.env.PIP_MIRROR_DEFAULT || '';
const GO_PROXY_DEFAULT = process.env.GO_PROXY_DEFAULT || '';
const PIP_ORIGINAL = 'https://pypi.org/simple'; // gitleaks:allow 官方 PyPI 源，功能必需
const GO_PROXY_ORIGINAL = 'https://proxy.golang.org/'; // gitleaks:allow 官方 Go 代理，功能必需
const SPEED_TEST_TIMEOUT = 5;
let PIP_MIRROR = '';
let GO_PROXY = '';
const PIP_TIMEOUT = '120';

// 报告生成相关常量
const REPORT_DIR_DEFAULT = '/tmp/pre-commit-reports/'; // 各工具扫描报告约定目录（机器临时目录）

function getInput(name) {
  // 兼容连字符与下划线两种命名：report-dir 同时支持 INPUT_REPORT-DIR / INPUT_REPORT_DIR
  const dashKey = `INPUT_${name.toUpperCase().replace(/-/g, '-')}`;
  const underscoreKey = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  const val = process.env[dashKey] || process.env[underscoreKey] || '';
  const trimmed = val.trim();

  if (name === 'extra_args' && trimmed) {
    const allowedArgs = ['--all', '--all-files', '--help', '--show-diff-on-failure', '--from-ref', '--to-ref', '--files'];
    const argsWithValue = ['--from-ref', '--to-ref', '--files'];
    const args = trimmed.split(' ');
    let skipNext = false;
    for (const arg of args) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (argsWithValue.includes(arg)) {
        skipNext = true;
        continue;
      }
      if (!allowedArgs.includes(arg) && !arg.startsWith('--')) {
        console.log(`[ERROR] Invalid extra_args: ${arg}. Only -- arguments are allowed.`);
        process.exit(1);
      }
    }
  }

  return trimmed;
}

/** 输出 action output（GitCode STEP_OUTPUT 机制，与 openlibing-upload-sarif 一致） */
function setOutput(key, value) {
  const stepOutput = process.env.STEP_OUTPUT;
  if (!stepOutput) {
    console.log(`[WARN] STEP_OUTPUT env not set, skip output: ${key}=${value}`);
    return;
  }
  let filePath;
  try {
    filePath = fs.statSync(stepOutput).isDirectory() ? path.join(stepOutput, 'output') : stepOutput;
  } catch (e) {
    // 文件不存在但父目录有效时按文件路径追加（appendFileSync 自动创建）
    const parentDir = path.dirname(stepOutput);
    if (!(fs.existsSync(parentDir) && fs.statSync(parentDir).isDirectory())) {
      console.log(`[WARN] STEP_OUTPUT path is invalid, skip output: ${key}=${value}`);
      return;
    }
    filePath = stepOutput;
  }
  fs.appendFileSync(filePath, `${key}=${value}\n`, 'utf-8');
  console.log(`[OUTPUT] ${key}=${value}`);
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

// 数组传参执行，不经 shell 解析（Ref issue #26）；stderr 丢弃，仅捕获 stdout
function execCapture(argv) {
  try {
    return execFileSync(argv[0], argv.slice(1), { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return '';
  }
}

function testUrlSpeed(url) {
  const result = execCapture(['curl', '-s', '-o', '/dev/null', '-w', '%{time_total}', '--max-time', String(SPEED_TEST_TIMEOUT), url]);
  if (!result) return -1;
  const seconds = parseFloat(result);
  if (isNaN(seconds) || seconds <= 0) return -1;
  return Math.round(seconds * 1000);
}

function detectMirrorConfig() {
  console.log('[INFO] 开始网络测速，选择最快的源...');

  // 镜像地址由环境变量注入；未配置时跳过镜像测速，直接使用官方源
  if (!PIP_MIRROR_DEFAULT) {
    PIP_MIRROR = PIP_ORIGINAL;
    console.log('[INFO] 未配置 PIP_MIRROR_DEFAULT 环境变量，使用 PyPI 官方源');
  } else {
    const pipOriginalMs = testUrlSpeed(PIP_ORIGINAL);
    const pipMirrorMs = testUrlSpeed(PIP_MIRROR_DEFAULT);

    console.log(`[INFO] PyPI 源站 (${PIP_ORIGINAL}) 响应: ${pipOriginalMs >= 0 ? pipOriginalMs + 'ms' : '超时/不可达'}`);
    console.log(`[INFO] 配置镜像 (${PIP_MIRROR_DEFAULT}) 响应: ${pipMirrorMs >= 0 ? pipMirrorMs + 'ms' : '超时/不可达'}`);

    if (pipOriginalMs < 0 && pipMirrorMs < 0) {
      PIP_MIRROR = PIP_ORIGINAL;
      console.log('[WARN] PyPI 源站和镜像均不可达，默认使用源站');
    } else if (pipOriginalMs < 0) {
      PIP_MIRROR = PIP_MIRROR_DEFAULT;
      console.log('[INFO] PyPI 源站不可达，使用配置镜像');
    } else if (pipMirrorMs < 0) {
      PIP_MIRROR = PIP_ORIGINAL;
      console.log('[INFO] 配置镜像不可达，使用 PyPI 源站');
    } else if (pipOriginalMs <= pipMirrorMs) {
      PIP_MIRROR = PIP_ORIGINAL;
      console.log(`[OK] PyPI 源站更快 (${pipOriginalMs}ms <= ${pipMirrorMs}ms)，使用源站`);
    } else {
      PIP_MIRROR = PIP_MIRROR_DEFAULT;
      console.log(`[OK] 配置镜像更快 (${pipMirrorMs}ms < ${pipOriginalMs}ms)，使用镜像`);
    }
  }

  const goVersion = execCapture(['go', 'version']);
  if (goVersion) {
    if (!GO_PROXY_DEFAULT) {
      GO_PROXY = GO_PROXY_ORIGINAL;
      console.log('[INFO] 未配置 GO_PROXY_DEFAULT 环境变量，使用 Go 官方代理');
    } else {
      const goOriginalMs = testUrlSpeed(GO_PROXY_ORIGINAL);
      const goMirrorMs = testUrlSpeed(GO_PROXY_DEFAULT);

      console.log(`[INFO] Go 源站 (${GO_PROXY_ORIGINAL}) 响应: ${goOriginalMs >= 0 ? goOriginalMs + 'ms' : '超时/不可达'}`);
      console.log(`[INFO] 配置镜像 (${GO_PROXY_DEFAULT}) 响应: ${goMirrorMs >= 0 ? goMirrorMs + 'ms' : '超时/不可达'}`);

      if (goOriginalMs < 0 && goMirrorMs < 0) {
        GO_PROXY = GO_PROXY_ORIGINAL;
        console.log('[WARN] Go 源站和镜像均不可达，默认使用源站');
      } else if (goOriginalMs < 0) {
        GO_PROXY = GO_PROXY_DEFAULT;
        console.log('[INFO] Go 源站不可达，使用配置镜像');
      } else if (goMirrorMs < 0) {
        GO_PROXY = GO_PROXY_ORIGINAL;
        console.log('[INFO] 配置镜像不可达，使用 Go 源站');
      } else if (goOriginalMs <= goMirrorMs) {
        GO_PROXY = GO_PROXY_ORIGINAL;
        console.log(`[OK] Go 源站更快 (${goOriginalMs}ms <= ${goMirrorMs}ms)，使用源站`);
      } else {
        GO_PROXY = GO_PROXY_DEFAULT;
        console.log(`[OK] 配置镜像更快 (${goMirrorMs}ms < ${goOriginalMs}ms)，使用镜像`);
      }
    }
  } else {
    GO_PROXY = GO_PROXY_ORIGINAL;
    console.log('[INFO] Go 未安装，跳过 Go 代理测速');
  }
}

function buildAutoArgs() {
  const eventName = (process.env.ATOMGIT_EVENT_NAME || '').toLowerCase();
  const baseRef = process.env.ATOMGIT_BASE_REF || '';
  console.log(`[INFO] 当前事件: ${eventName || '(未知)'}, 目标分支: ${baseRef || '(无)'}`);

  if ((eventName === 'mr' || eventName === 'pull_request' || eventName === 'note') && baseRef) {
    console.log(`[INFO] 检测到 PR 事件，目标分支: ${baseRef}`);

    // 使用 gc_token 注入 remote URL 认证，确保 git fetch 能访问私有仓库
    const token = getInput('gc_token');
    if (token) {
      const remoteUrl = execCapture(['git', 'remote', 'get-url', 'origin']);
      if (remoteUrl && remoteUrl.startsWith('https://')) {
        const encodedToken = encodeURIComponent(token);
        const authUrl = remoteUrl.replace('https://', `https://oauth2:${encodedToken}@`);
        execCapture(['git', 'remote', 'set-url', 'origin', authUrl]);
      }
    }

    console.log(`[INFO] 拉取目标分支 origin/${baseRef} 以获取增量文件`);
    execFile('git', ['fetch', 'origin', baseRef]);

    console.log(`[INFO] 使用 --from-ref FETCH_HEAD --to-ref HEAD 增量检查`);
    return { type: 'args', args: `--from-ref FETCH_HEAD --to-ref HEAD` };
  }

  console.log('[INFO] 非 PR 事件，使用 --all-files 检查全量文件');
  return { type: 'args', args: '--all-files' };
}

/**
 * 流式执行子进程：实时转发 stdout/stderr 到控制台，同时完整累积输出文本。
 * 不使用 spawnSync：其默认 maxBuffer 仅 1MB，大型项目（如 C 项目 clang-tidy 全量检查）
 * 输出超限时会被硬截断并抛 ERR_CHILD_PROCESS_STDIO_MAXBUFFER，导致：
 *   1) 误判为"钩子安装/环境错误"（sp.error 非空 → failureType=install）；
 *   2) 日志兜底解析（parsePreCommitLog / generateFallbackSarif）依据缺失。
 * @param {string} command 可执行文件
 * @param {string[]} args 命令行参数
 * @param {object} [options] spawn 选项（如 cwd）
 * @returns {Promise<{status: (number|null), error: (Error|undefined), output: string}>}
 */
function runStreaming(command, args, options = {}) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let sp;
    try {
      sp = spawn(command, args, { cwd: options.cwd });
    } catch (e) {
      done({ status: null, error: e, output });
      return;
    }

    sp.stdout.setEncoding('utf8');
    sp.stderr.setEncoding('utf8');
    // 防御：子进程管道异常中断（如被强杀）时流可能触发 error，未监听会抛未捕获异常导致 action 崩溃
    sp.stdout.on('error', (err) => {
      console.log(`[WARN] pre-commit 输出流异常（stdout）: ${err.message}`);
    });
    sp.stderr.on('error', (err) => {
      console.log(`[WARN] pre-commit 输出流异常（stderr）: ${err.message}`);
    });
    sp.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    sp.stderr.on('data', (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    sp.on('error', (err) => done({ status: null, error: err, output }));
    sp.on('close', (code, signal) => {
      if (code === null && signal) {
        console.log(`[WARN] pre-commit 子进程被信号终止: ${signal}`);
      }
      done({ status: code, error: undefined, output });
    });
  });
}

async function runPreCommit(cmdResult) {
  if (cmdResult.type === 'skip') {
    console.log('[OK] 无需检查');
    return { failed: false, output: '' };
  }

  // 流式捕获 pre_commit run 的输出（stdout+stderr），实时转发控制台且完整累积，
  // 供用户未提供 SARIF 时的日志兜底解析；不使用 spawnSync 以免 maxBuffer 截断大输出。
  const runArgs = cmdResult.type === 'file'
    ? ['-m', 'pre_commit', 'run', '--files', ...cmdResult.files]
    : ['-m', 'pre_commit', 'run', ...cmdResult.args.split(' ')];
  console.log(`> python ${runArgs.join(' ')}`);

  const { status, error, output } = await runStreaming('python', runArgs, { cwd: process.cwd() });

  const checkFailed = status !== 0;
  if (checkFailed) {
    // 区分"检查出告警"与"钩子安装/环境失败"：
    //  - 检查出告警：钩子正常运行，输出含标准 "xxx....Failed" 钩子状态行（parsePreCommitLog 可解析出失败钩子）
    //  - 安装/环境失败：spawn 失败、无失败钩子状态行，或输出含 pre-commit 未预期错误标志
    const hasFailureHooks = parsePreCommitLog(output).length > 0;
    const unexpectedError = /An unexpected error has occurred|Failed to install|InstallError|error occurred/i.test(output);
    const installError = error !== undefined || !hasFailureHooks || unexpectedError;

    if (installError) {
      console.log('[ERROR] pre-commit 执行失败（钩子安装或环境错误），任务按失败状态退出');
      console.log('[INFO] 请检查网络连通性、钩子仓库地址（建议 GitCode 镜像仓）、.pre-commit-config.yaml 配置后重试');
      console.log('      详细错误可查看 pre-commit 日志: ~/.cache/pre-commit/pre-commit.log');
      console.log('\n[INFO] 如需了解更多 pre-commit 配置等信息，请查阅项目 README 或内部文档站点');
      return { failed: true, output, failureType: 'install' };
    }

    // 检查出告警（钩子正常运行但发现问题）
    console.log('[ERROR] pre-commit 检查发现告警');
    console.log('\n[INFO] 请在本地执行以下命令修复后重新提交:');
    console.log('1. 安装/初始化环境');
    console.log('   pip install pre-commit && pre-commit install --install-hooks');
    console.log('2. 检查并修复变更文件');
    if (cmdResult.type === 'file') {
      console.log(`   pre-commit run --files ${cmdResult.files.join(' ')}`);
    } else {
      console.log('   pre-commit run --all-files');
    }
    console.log('\n[INFO] 如需了解更多告警屏蔽、pre-commit配置等信息，请查阅项目 README 或内部文档站点');
    // 不在此退出：pre-commit 失败时扫描报告同样有价值，报告上传完成后由 run() 统一按失败状态退出
    return { failed: true, output, failureType: 'check' };
  }
  console.log('[OK] pre-commit 检查通过');
  console.log('[INFO] 如需了解更多告警屏蔽、pre-commit配置等信息，请查阅项目 README 或内部文档站点');
  return { failed: false, output, failureType: 'none' };
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
      // uri 归一化与代码上下文补齐由 openlibing-upload-sarif 在上传前完成，此处直接写盘
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

/** 是否为 PR 类型触发（门禁场景：pre-commit 检查失败必须退出阻塞合并）。
 * 与 buildAutoArgs 的 PR 判断保持一致。 */
function isPrEvent() {
  const eventName = (process.env.ATOMGIT_EVENT_NAME || '').toLowerCase();
  const baseRef = process.env.ATOMGIT_BASE_REF || '';
  return (eventName === 'mr' || eventName === 'pull_request' || eventName === 'note') && baseRef;
}

/** 收集 SARIF 报告：优先收集业务仓转换好的 *.sarif（用户通过 sarif-file / report-dir 提供）；
 * 若报告目录无 *.sarif，则解析 pre-commit 运行日志生成兜底 SARIF（防止用户未提供报告的场景）。
 * 只负责生成/归一化报告文件，不做上传回调——上传由 workflow 中 openlibing-upload-sarif 完成。
 * PR 类型触发（mr / pull_request / note）只做门禁检查，不生成/收集报告。
 * @param {string} preCommitOutput pre_commit run 的捕获输出（stdout+stderr）
 * @returns {string[]} 收集到的 SARIF 文件绝对路径数组（可能为空） */
function collectScanReports(preCommitOutput) {
  console.log('\n===== [7] 报告收集与兜底生成（上传交由 workflow 中的 openlibing-upload-sarif） =====');

  // PR 场景只做门禁检查，不生成报告（门禁失败退出逻辑在 run() 中处理）
  if (isPrEvent()) {
    console.log('[INFO] PR 类型触发，按约定不生成/收集 SARIF 报告，跳过');
    return [];
  }

  const reportDir = getInput('report-dir') || REPORT_DIR_DEFAULT;
  const workspace = process.env.WORKSPACE || process.cwd();

  // 用户提供的报告（绝对路径列表）：
  //   1) sarif-file 输入：逗号分隔的文件/目录（目录非递归扫描 *.sarif），与 openlibing-upload-sarif 一致
  //   2) report-dir 目录扫描：向后兼容既有行为
  const candidatePaths = [];
  const sarifFileInput = getInput('sarif-file');
  if (sarifFileInput) {
    sarifFileInput.split(',').map(s => s.trim()).filter(Boolean).forEach(p => candidatePaths.push(p));
  }
  if (fs.existsSync(reportDir)) {
    fs.readdirSync(reportDir)
      .filter(f => f.endsWith('.sarif'))
      .sort()
      .forEach(f => candidatePaths.push(path.join(reportDir, f)));
  } else {
    console.log(`[INFO] 报告目录不存在，尝试从 pre-commit 日志兜底生成: ${reportDir}`);
  }

  const userSarifFiles = [];
  const missingPaths = [];
  for (const rawPath of candidatePaths) {
    let p = rawPath;
    if (!fs.existsSync(p)) {
      const joined = path.join(workspace, rawPath);
      if (fs.existsSync(joined)) p = joined;
    }
    if (!fs.existsSync(p)) {
      missingPaths.push(rawPath);
      continue;
    }
    if (fs.statSync(p).isDirectory()) {
      console.log(`[INFO] 输入为目录: ${p}，扫描其中所有 .sarif 文件`);
      const found = fs.readdirSync(p)
        .filter(f => f.toLowerCase().endsWith('.sarif'))
        .map(f => path.join(p, f));
      if (found.length === 0) console.log(`[WARN] 目录中未找到 .sarif 文件: ${p}`);
      userSarifFiles.push(...found);
    } else {
      userSarifFiles.push(p);
    }
  }
  // 去重（同名文件保留首个）
  const seen = new Set();
  const userSarifFilesDedup = userSarifFiles.filter(f => {
    const key = path.basename(f);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  userSarifFiles.length = 0;
  userSarifFiles.push(...userSarifFilesDedup);
  if (missingPaths.length > 0) {
    // 报告属附加能力，路径缺失不阻断 pre-commit 检查主流程，仅告警
    console.log(`[WARN] SARIF 路径不存在（已忽略）: ${missingPaths.join(', ')}`);
  }

  // 按工具维度补齐：失败钩子对应工具已有用户 sarif 直接用；
  // 未提供且支持日志解析则生成 <tool>.sarif；未提供且不支持则提示。
  const existingNames = userSarifFiles.map(f => path.basename(f));
  const fallbackFiles = generateFallbackSarif(preCommitOutput, existingNames);
  if (fallbackFiles.length > 0) {
    console.log('[INFO] 已根据 pre-commit 日志生成兜底 SARIF: ' + fallbackFiles.join(', '));
  }

  // 上传列表 = 用户提供的报告（绝对路径） + 兜底生成的文件（report-dir 下）
  const uploadFiles = userSarifFiles.map(f => ({ file: f, name: path.basename(f) }));
  for (const name of fallbackFiles) {
    uploadFiles.push({ file: path.join(reportDir, name), name });
  }

  if (uploadFiles.length === 0) {
    console.log(`[INFO] 无 SARIF 报告可生成（失败钩子工具均未提供 sarif 且不支持日志解析）: ${reportDir}`);
    return [];
  }

  // 上传前不做 uri 归一化/代码上下文补齐：由 openlibing-upload-sarif 统一完成，避免双份逻辑

  console.log(`[OK] 收集到 ${uploadFiles.length} 个 SARIF 报告:`);
  uploadFiles.forEach(u => console.log(`  - ${u.file}`));

  // 返回文件绝对路径列表，供 run() 输出到 sarif-files output，
  // workflow 中 openlibing-upload-sarif 的 sarif-file input 可直接消费。
  return uploadFiles.map(u => u.file);
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
  const goVersion = execCapture(['go', 'version']);
  console.log(`[INFO] goVersion = "${goVersion}"`);
  if (goVersion) {
    execFile('go', ['env', '-w', 'GO111MODULE=on']);
    execFile('go', ['env', '-w', `GOPROXY=${GO_PROXY}`]);
    // 不再设置 GONOSUMDB=*（Ref issue #31）：本平台仓无私有 Go 模块，
    // 公共模块全部走 sum.golang.org 校验，保留供应链完整性防线
  } else {
    console.log('[WARN] Go 未安装，跳过 Go 代理配置');
  }
  const MIN_PIP_VERSION = '21.0';
  const pipVersionOutput = execCapture(['python', '-m', 'pip', '--version']);
  const pipVersionMatch = pipVersionOutput.match(/pip\s+(\d+\.\d+)/);
  if (pipVersionMatch) {
    const currentVersion = parseFloat(pipVersionMatch[1]);
    const minVersion = parseFloat(MIN_PIP_VERSION);
    if (currentVersion >= minVersion) {
      console.log(`[OK] pip ${pipVersionMatch[1]} 已安装且 >= ${MIN_PIP_VERSION}，跳过升级`);
    } else {
      console.log(`[INFO] pip ${pipVersionMatch[1]} < ${MIN_PIP_VERSION}，使用 --ignore-installed 升级（避免卸载系统 pip 失败）`);
      execFile('python', ['-m', 'pip', 'install', '--ignore-installed', '--upgrade', 'pip', '--timeout', PIP_TIMEOUT]);
    }
  } else {
    console.log('[INFO] pip 未安装，开始安装 pip');
    execFile('python', ['-m', 'pip', 'install', '--upgrade', 'pip', '--timeout', PIP_TIMEOUT]);
  }
  // 固定 pre-commit 版本（Ref issue #23），防止 PyPI 上游投毒随 latest 自动引入；
  // 升级需按安全整改节奏手动更新版本号，不做 --require-hashes
  const PRE_COMMIT_VERSION = '4.7.0';
  execFile('python', ['-m', 'pip', 'install', `pre-commit==${PRE_COMMIT_VERSION}`, '--timeout', PIP_TIMEOUT]);
  execFile('python', ['-m', 'pre_commit', '--version']);

  console.log('\n===== [3] 定位代码目录 =====');
  const workspace = process.env.WORKSPACE || process.cwd();

  if (!/^\/[\w\-/.]+$/.test(workspace)) {
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
  const preCommitResult = await runPreCommit(cmdResult);

  // 收集/兜底生成 SARIF 报告文件（不做上传回调，上传由 workflow 中的 openlibing-upload-sarif 完成）
  const sarifFiles = collectScanReports(preCommitResult.output);
  if (sarifFiles.length > 0) {
    // 输出到 sarif-files，workflow 中 openlibing-upload-sarif 的 sarif-file input 可直接消费
    setOutput('sarif-files', sarifFiles.join(','));
  }

  if (preCommitResult.failed) {
    if (preCommitResult.failureType === 'install') {
      // 钩子安装/环境失败：任何场景都必须任务失败（不是检查出告警）
      console.log('[ERROR] pre-commit 钩子安装或环境错误，任务按失败状态退出');
      process.exit(1);
    }
    if (isPrEvent()) {
      // 门禁场景（PR 增量检查）：检查失败必须退出，阻塞合并
      console.log('[ERROR] pre-commit 检查失败（门禁），任务按失败状态退出');
      process.exit(1);
    } else {
      // 版本级场景（push / workflow_dispatch / schedule 全量检查）：
      // 报告文件已生成（sarif-files output），上传与解析由 workflow 负责，检查发现告警仅提示，不按失败退出
      console.log('[WARN] pre-commit 检查发现告警（版本级），扫描报告已生成，任务不按失败状态退出');
    }
  }
}

if (require.main === module) {
  run().catch(err => {
    const sanitizedMessage = sanitizePath(err.message);
    console.error(`Action 执行失败: ${sanitizedMessage}`);
    process.exit(1);
  });
}

module.exports = {
  run,
  collectScanReports,
  parsePreCommitLog,
  generateFallbackSarif
};
