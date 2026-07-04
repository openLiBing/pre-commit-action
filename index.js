const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PIP_MIRROR_DEFAULT = 'https://mirrors.huaweicloud.com/repository/pypi/simple';
const GO_PROXY_DEFAULT = 'https://mirrors.huaweicloud.com/repository/goproxy/';
const PIP_ORIGINAL = 'https://pypi.org/simple';
const GO_PROXY_ORIGINAL = 'https://proxy.golang.org/';
const SPEED_TEST_TIMEOUT = 5;
let PIP_MIRROR = '';
let GO_PROXY = '';
const PIP_TIMEOUT = '120';
const BATCH_SIZE = 30;
const DEFAULT_SUPPORTED_HOOKS = ['clang-format', 'ruff-format', 'trailing-whitespace', 'end-of-file-fixer'];
const USER = { login: 'pre_commit_action', email: 'pre-commit-action@openlibing.com'};
const GC_TOKEN = getInput('GC_TOKEN');

function getInput(name) {
  const val = process.env[`INPUT_${name.toUpperCase()}`] || '';
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

function parsePreCommitHooks(configPath) {
  const content = fs.readFileSync(configPath, 'utf-8');
  const hookIds = [];
  const re = /^\s*-\s+id:\s*['"]?([\w.-]+)['"]?\s*(?:#.*)?$/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    hookIds.push(m[1]);
  }
  return hookIds;
}

function classifyHooks(configuredHooks) {
  const supportedSet = new Set(DEFAULT_SUPPORTED_HOOKS);
  const supported = [];
  const unsupported = [];
  for (const hookId of configuredHooks) {
    if (supportedSet.has(hookId)) {
      supported.push(hookId);
    } else {
      unsupported.push(hookId);
    }
  }
  return [supported, unsupported];
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

function getLoginEmail() {
  if (!GC_TOKEN) {
    console.log('[WARN] GC_TOKEN 未设置，使用默认信息');
  } else {
    const repoUrl = process.env.ATOMGIT_REPOSITORY_URL;
    const urlPattern = /^https?:\/\/([^\/]+)/;
    const match = repoUrl.match(urlPattern);

    if (!match) {
      console.log('[ERROR] Invalid repository URL');
      process.exit(1);
    }

    const hostname = match[1];
    const allowedHosts = ['gitcode.net', 'test.gitcode.net', 'gitee.com'];

    if (!allowedHosts.some(h => hostname === h || hostname.endsWith('.' + h))) {
      console.log(`[ERROR] Invalid repository host: ${hostname}`);
      process.exit(1);
    }

    let host = hostname.includes('test.gitcode.net') ? 'test.gitcode.net' : 'api.gitcode.com';

    try {
      console.log('[INFO] 开始通过接口获取 GC_TOKEN 对应用户信息');
      const output = execCapture(`curl -s --max-time 10 'https://${host}/api/v5/user' --header 'PRIVATE-TOKEN: ${GC_TOKEN}'`);
      if (output) {
        console.log(`output: ${output}`);
        const resp = JSON.parse(output);
        const login = resp.login || resp.name || USER.login;
        const email = resp.email || USER.email;
        USER.login = login;
        USER.email = email;
      } else {
        console.log(`[ERROR] 通过接口获取 GC_TOKEN 对应用户信息为空，使用默认信息`);
      }
    } catch (e) {
      console.log(`[ERROR] 通过接口获取 GC_TOKEN 对应用户信息失败，使用默认信息`, e);
    }
  }
  console.log(`- Login: ${USER.login}`);
  console.log(`- Email: ${USER.email}`);
}

function buildAutoArgs() {
  const eventName = (process.env.ATOMGIT_EVENT_NAME || '').toLowerCase();
  const baseRef = process.env.ATOMGIT_BASE_REF || '';
  const headRef = process.env.ATOMGIT_HEAD_REF || '';

  if ((eventName === 'mr' || eventName === 'pull_request') && baseRef && headRef) {
    console.log(`[INFO] 检测到 PR 事件: ${headRef} -> ${baseRef}`);
    exec(`git config --global core.quotepath false`);
    execFile('git', ['config', 'user.name', USER.login]);
    execFile('git', ['config', 'user.email', USER.email]);
    exec(`git fetch origin refs/merge-requests/${process.env.MERGE_REQUEST_IID}/head:pr_${process.env.MERGE_REQUEST_IID}`);
    exec(`git fetch origin ${baseRef} --unshallow`); // 环境默认拉取深度为1，需要重新拉取，否则merge会失败
    exec(`git checkout pr_${process.env.MERGE_REQUEST_IID}`);
    try {
      exec(`git merge origin/${baseRef} --no-edit`);
    } catch (e) {
      console.error("[ERROR] 合并PR修改到目标分支失败，请优先处理冲突 (或检查PR与target是否共享历史)");
      throw e;
    }
    let diffFiles = execCapture(`git diff ${baseRef}...pr_${process.env.MERGE_REQUEST_IID} --name-only --diff-filter=ACMR`);
    return { type: 'file', files: diffFiles.split('\n')};
  }
  console.log('[INFO] 非 PR 事件，使用 --all 检查全量文件');
  return { type: 'args', args: '--all' };
}

function runPreCommit(cmdResult, hooks, failExit) {
  let checkFailed = false;
  if (cmdResult.type === 'file') {
    if (!hooks || hooks.length === 0) {
      console.log('[INFO] 没有需要运行的 hook');
      return;
    }
    let batchFiles = [];
    for (let i = 0; i < cmdResult.files.length; i++) {
      batchFiles.push(cmdResult.files[i])
      if (batchFiles.length === BATCH_SIZE || i === cmdResult.files.length - 1) {
        for (const hook of hooks) {
          try {
            execFile('python', ['-m', 'pre_commit', 'run', hook, '--files', ...batchFiles]);
            console.log(`[OK] ${hook} 检查通过`);
          } catch (e) {
            checkFailed = true;
          }
        }
        batchFiles = []
      }
    }
  } else {
    try {
      execFile('python', ['-m', 'pre_commit', 'run', ...cmdResult.args.split(' ')])
      console.log('[INFO] 自定义命令参数执行 pre-commit 检查通过');
      process.exit(0);
    } catch (e) {
      checkFailed = true;
    }
  }
  if (checkFailed && failExit) {
    console.log('[ERROR] pre-commit 检查失败');
    console.log('\n[INFO] 请在本地执行以下命令修复后重新提交:');
    console.log('1. 安装/初始化环境');
    console.log('   pip install pre-commit && pre-commit install --install-hooks');
    console.log('2. 检查并修复变更文件');
    process.exit(1);
  }
}

function commitAndPushAutoFix(prFiles) {
  const statusOutput = execCapture('git status --porcelain');
  console.log('git status --porcelain');
  if (!statusOutput) {
    console.log('[INFO] pre-commit 修复无内容修改，无需推送');
    return;
  }
  console.log(`${statusOutput}`);
  console.log(`[INFO] 本次 PR 修改文件: `);
  for (let file of prFiles) {
    console.log(`  - ${file}`);
  }
  const diffFiles = statusOutput.split('\n').filter(line => line.trim()).map(line => line.substring(3)).filter(f => prFiles.includes(f));
  console.log(`[INFO] pre-commit 修复文件: `);
  for (let file of diffFiles) {
    console.log(`  - ${file}`);
  }
  try {
    const webhook = JSON.parse(process.env.WEBHOOK_PAYLOAD);
    const randDir = path.join(os.tmpdir(), `${process.env.ATOMGIT_REPOSITORY}-${Date.now()}`);
    console.log(`[INFO] 开始下载 fork 仓库到临时目录: ${randDir}`);
    let forkUrl = webhook.merge_request.source.git_http_url;

    const allowedHosts = ['gitcode.net', 'test.gitcode.net', 'gitee.com'];
    const parsedUrl = new URL(forkUrl);
    if (!allowedHosts.includes(parsedUrl.hostname)) {
      console.log(`[ERROR] Invalid repository host: ${parsedUrl.hostname}`);
      process.exit(1);
    }

    if (GC_TOKEN) {
      forkUrl = forkUrl.replace('https://', `https://oauth2:${GC_TOKEN}@`);
    }

    const headRef = process.env.ATOMGIT_HEAD_REF;
    execFile('git', ['clone', '-b', headRef, forkUrl, randDir]);
    for (let diffFile of diffFiles) {
      fs.copyFileSync(diffFile, path.join(randDir, diffFile));
    }
    execFile('git', ['config', 'user.name', USER.login], { cwd: randDir });
    execFile('git', ['config', 'user.email', USER.email], { cwd: randDir });
    exec(`cd "${randDir}" && git commit -am "[openlibing.ci] auto fixes by pre-commit"`);
    exec(`cd "${randDir}" && git push`);
    console.log('[OK] 已成功推送修改到 PR');
  } catch (e) {
    console.log(`[ERROR] 提交或推送失败，请添加有权限推送的 GC_TOKEN`);
    process.exit(1);
  }
}

async function run() {
  const extraArgs = getInput('extra_args');
  console.log('===== pre-commit-action 启动 =====');

  console.log('\n===== [1] 检查 Python 环境 =====');
  exec('python --version');

  console.log('\n===== [2] 安装 pre-commit =====');
  detectMirrorConfig();
  exec(`python -m pip config set global.index-url ${PIP_MIRROR}`);
  console.log('[INFO] 检查 Go 环境...');
  const goVersion = execCapture('go version');
  console.log(`[INFO] goVersion = "${goVersion}"`);
  if (goVersion) {
    exec(`go env -w GO111MODULE=on`);
    exec(`go env -w GOPROXY=${GO_PROXY}`);
    exec(`go env -w GONOSUMDB=*`);
  } else {
    console.log('[WARN] Go 未安装，跳过 Go 代理配置');
  }
  exec(`python -m pip install --upgrade pip --timeout ${PIP_TIMEOUT}`);
  exec(`python -m pip install pre-commit --timeout ${PIP_TIMEOUT}`);
  exec('python -m pre_commit --version');

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
  let supportedHooks = [];
  let unsupportedHooks = [];
  if (!fs.existsSync('.pre-commit-config.yaml')) {
    console.log('[INFO] 未找到 .pre-commit-config.yaml，跳过 pre-commit 检查');
    return;
  }
  console.log('[OK] 找到 .pre-commit-config.yaml');

  console.log('\n===== [5] 构建运行参数 =====');
  getLoginEmail();
  let cmdResult;
  if (extraArgs) {
    console.log(`[INFO] 检测到自定义参数: ${extraArgs}`);
    cmdResult = { type: 'args', args: extraArgs };
  } else {
    console.log('[INFO] 未指定参数，自动判断检查模式');
    cmdResult = buildAutoArgs();
  }
  if (cmdResult.type === 'args') {
    console.log(`指定参数执行: ${cmdResult.args}`);
  } else {
    if (cmdResult.files.length === 0) {
      console.log(`无任何变更文件，无需检查`)
      return;
    }
  }

  try {
    const configuredHooks = parsePreCommitHooks('.pre-commit-config.yaml');
    [supportedHooks, unsupportedHooks] = classifyHooks(configuredHooks);
    console.log(`[INFO] 已配置 hook 总数: ${configuredHooks.length}`);
    console.log(`[INFO] 未默认支持的 hook (${unsupportedHooks.length} 个):`);
    if (unsupportedHooks.length === 0) {
      console.log('  - (无)');
    } else {
      unsupportedHooks.forEach(h => console.log(`  - ${h}`));
    }
    console.log(`[INFO] 默认支持的 hook (${supportedHooks.length} 个):`);
    if (supportedHooks.length === 0) {
      console.log('  - (无)');
    } else {
      supportedHooks.forEach(h => console.log(`  - ${h}`));
    }
  } catch (e) {
    console.log(`[WARN] 解析配置失败: ${e.message}`);
  }

  console.log('\n===== [6] 运行未默认支持的 hook 检查 =====');
  runPreCommit(cmdResult, unsupportedHooks, true);

  console.log('\n===== [7] 运行默认支持的 hook 检查 =====');
  runPreCommit(cmdResult, supportedHooks, false);

  console.log('\n===== [8] 推送修改到原仓 =====');
  commitAndPushAutoFix(cmdResult.files);
}

run().catch(err => {
  const sanitizedMessage = sanitizePath(err.message);
  console.error(`Action 执行失败: ${sanitizedMessage}`);
  process.exit(1);
});
