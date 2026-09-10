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

function getInput(name) {
  const val = process.env[`INPUT_${name.toUpperCase()}`] || '';
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

function fetchPrFiles(apiUrl, repo, prNumber, token) {
  const url = `${apiUrl}/api/v5/repos/${repo}/pulls/${prNumber}/files.json?access_token=${encodeURIComponent(token)}&per_page=100`;
  const output = execCapture(`curl -sf "${url}"`);
  if (!output) {
    console.log('[WARN] API 请求变更文件列表失败');
    return [];
  }
  try {
    const data = JSON.parse(output);
    return data.map(f => f.filename);
  } catch (e) {
    console.log(`[WARN] 解析 PR 文件列表失败: ${e.message}`);
    return [];
  }
}

function buildAutoArgs() {
  const eventName = (process.env.ATOMGIT_EVENT_NAME || '').toLowerCase();
  const baseRef = process.env.ATOMGIT_BASE_REF || '';
  console.log(`[INFO] 当前事件: ${eventName || '(未知)'}, 目标分支: ${baseRef || '(无)'}`);

  if ((eventName === 'mr' || eventName === 'pull_request' || eventName === 'note') && baseRef) {
    console.log(`[INFO] 检测到 PR 事件，目标分支: ${baseRef}`);

    const autoToken = process.env.ATOMGIT_TOKEN || '';
    const apiUrl = process.env.ATOMGIT_API_URL || 'https://api.gitcode.com';
    const repo = process.env.ATOMGIT_REPOSITORY || '';
    console.log(`[INFO] API 配置: repo=${repo || '(空)'}, apiUrl=${apiUrl}, token=${autoToken ? '(已设置)' : '(未设置)'}`);

    let prNumber = '';
    const eventPath = process.env.ATOMGIT_EVENT_PATH || '';
    if (eventPath && fs.existsSync(eventPath)) {
      try {
        const eventData = JSON.parse(fs.readFileSync(eventPath, { encoding: 'utf-8' }));
        prNumber = eventData.pull_request?.number || eventData.number || '';
        console.log(`[INFO] 从 event.json 获取 PR number: ${prNumber || '(未找到)'}`);
      } catch (e) {
        console.log('[WARN] 解析 event.json 失败，跳过 API 获取变更文件列表');
      }
    } else {
      console.log(`[INFO] event.json 路径: ${eventPath || '(未设置)'}, 文件存在: ${eventPath && fs.existsSync(eventPath)}`);
    }

    if (autoToken && repo && prNumber) {
      console.log(`[INFO] 通过 API 获取 PR #${prNumber} 变更文件列表`);
      const files = fetchPrFiles(apiUrl, repo, prNumber, autoToken);
      if (files.length > 0) {
        console.log(`[INFO] PR 增量文件 (${files.length} 个):`);
        files.forEach(f => console.log(`  - ${f}`));
      } else {
        console.log('[INFO] API 未获取到变更文件列表');
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

function runPreCommit(cmdResult) {
  let checkFailed = false;

  if (cmdResult.type === 'skip') {
    console.log('[OK] 无需检查');
    return;
  }

  try {
    execFile('python', ['-m', 'pre_commit', 'run', ...cmdResult.args.split(' ')]);
  } catch (e) {
    checkFailed = true;
  }

  if (checkFailed) {
    console.log('[ERROR] pre-commit 检查失败');
    console.log('\n[INFO] 请在本地执行以下命令修复后重新提交:');
    console.log('1. 安装/初始化环境');
    console.log('   pip install pre-commit && pre-commit install --install-hooks');
    console.log('2. 检查并修复变更文件');
    console.log('   pre-commit run --all-files');
    console.log('\n如需了解更多告警屏蔽、pre-commit配置等信息，请查阅: https://gitcode.com/openlibing/docs/blob/main/static-code-analysis/solutions/pre-commit/README.md');
    process.exit(1);
  }
  console.log('[OK] pre-commit 检查通过');
  console.log('如需了解更多告警屏蔽、pre-commit配置等信息，请查阅: https://gitcode.com/openlibing/docs/blob/main/static-code-analysis/solutions/pre-commit/README.md');
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
  const MIN_PIP_VERSION = '21.0';
  const pipVersionOutput = execCapture('python -m pip --version');
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
  runPreCommit(cmdResult);
}

run().catch(err => {
  const sanitizedMessage = sanitizePath(err.message);
  console.error(`Action 执行失败: ${sanitizedMessage}`);
  process.exit(1);
});
