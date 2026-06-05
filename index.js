const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PIP_MIRROR = 'https://mirrors.huaweicloud.com/repository/pypi/simple';
const GO_PROXY = 'https://mirrors.huaweicloud.com/repository/goproxy/';
const PIP_TIMEOUT = '120';
const FILE_THRESHOLD = 50;

function getInput(name) {
  const val = process.env[`INPUT_${name.toUpperCase()}`] || '';
  return val.trim();
}

function setOutput(key, value) {
  const stepOutput = process.env.STEP_OUTPUT;
  if (!stepOutput) {
    console.log(`[WARN] STEP_OUTPUT env not set, skip output: ${key}=${value}`);
    return;
  }

  let filePath;
  try {
    const stat = fs.statSync(stepOutput);
    if (stat.isDirectory()) {
      filePath = path.join(stepOutput, 'output');
    } else {
      filePath = stepOutput;
    }
  } catch (e) {
    const parentDir = path.dirname(stepOutput);
    if (fs.existsSync(parentDir) && fs.statSync(parentDir).isDirectory()) {
      filePath = stepOutput;
    } else {
      console.log(`[WARN] STEP_OUTPUT path is invalid, skip output: ${key}=${value}`);
      return;
    }
  }

  const line = `${key}=${value}\n`;
  fs.appendFileSync(filePath, line, 'utf-8');
  console.log(`[OUTPUT] ${key}=${value}`);
}

function exec(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });
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

function buildAutoArgs() {
  const eventName = (process.env.ATOMGIT_EVENT_NAME || '').toLowerCase();
  const baseRef = process.env.ATOMGIT_BASE_REF || '';
  const headRef = process.env.ATOMGIT_HEAD_REF || '';
  const repoUrl = process.env.REPO_URL || process.env.ATOMGIT_SERVER_URL || '';
  const repository = process.env.ATOMGIT_REPOSITORY || '';

  if ((eventName === 'mr' || eventName === 'pull_request') && baseRef && headRef) {
    console.log(`[INFO] 检测到 PR 事件: ${headRef} -> ${baseRef}`);

    exec(`git fetch origin ${baseRef} 2>/dev/null || true`);
    exec(`git fetch origin ${headRef} 2>/dev/null || true`);

    let diffFiles = execCapture(`git diff --name-only origin/${baseRef}...origin/${headRef}`);

    if (!diffFiles && repoUrl && repository) {
      console.log('[INFO] origin 方式未获取到差异，尝试添加上游远程');
      const upstreamUrl = `${repoUrl}/${repository}`;
      exec(`git remote add upstream ${upstreamUrl} 2>/dev/null || true`);
      exec(`git fetch upstream ${baseRef} 2>/dev/null || true`);
      exec(`git fetch upstream ${headRef} 2>/dev/null || true`);

      diffFiles = execCapture(`git diff --name-only upstream/${baseRef}...upstream/${headRef}`);
      if (!diffFiles) {
        diffFiles = execCapture(`git diff --name-only origin/${baseRef}...upstream/${headRef}`);
      }
      if (!diffFiles) {
        diffFiles = execCapture(`git diff --name-only upstream/${baseRef}...origin/${headRef}`);
      }
    }

    if (!diffFiles) {
      const mergeBase = execCapture(`git merge-base origin/${baseRef} HEAD 2>/dev/null || git merge-base upstream/${baseRef} HEAD 2>/dev/null`);
      if (mergeBase) {
        console.log(`[INFO] 使用 merge-base 方式: ${mergeBase.substring(0, 8)}...HEAD`);
        diffFiles = execCapture(`git diff --name-only ${mergeBase}...HEAD`);
      }
    }

    if (diffFiles) {
      const fileList = diffFiles.split('\n').filter(f => f.trim());
      console.log(`[INFO] PR 变更文件 (${fileList.length} 个):`);
      fileList.forEach(f => console.log(`  - ${f}`));

      if (fileList.length > FILE_THRESHOLD) {
        console.log(`[INFO] 变更文件超过 ${FILE_THRESHOLD} 个，使用文件列表方式执行`);
        const tmpFile = path.join(os.tmpdir(), 'pre-commit-files.txt');
        fs.writeFileSync(tmpFile, diffFiles, 'utf-8');
        return { type: 'file', tmpFile, count: fileList.length };
      }

      return { type: 'args', value: `--files ${diffFiles.replace(/\n/g, ' ')}` };
    } else {
      console.log('[WARN] 未检测到差异文件，回退到 --all 模式');
      return { type: 'args', value: '--all' };
    }
  }

  console.log('[INFO] 非 PR 事件，使用 --all 检查全量文件');
  return { type: 'args', value: '--all' };
}

function runPreCommit(cmdResult) {
  if (cmdResult.type === 'file') {
    const content = fs.readFileSync(cmdResult.tmpFile, 'utf-8');
    const files = content.split('\n').filter(f => f.trim());
    const BATCH_SIZE = 30;
    let failed = false;

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const batchArgs = `--files ${batch.join(' ')}`;
      console.log(`\n[INFO] 批次 ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(files.length / BATCH_SIZE)} (${batch.length} 个文件)`);
      try {
        exec(`python -m pre_commit run ${batchArgs}`);
      } catch (e) {
        failed = true;
      }
    }

    try { fs.unlinkSync(cmdResult.tmpFile); } catch (e) {}
    if (failed) throw new Error('pre-commit check failed');
  } else {
    exec(`python -m pre_commit run ${cmdResult.value}`);
  }
}

async function run() {
  const extraArgs = getInput('extra_args');

  console.log('===== pre-commit-action 启动 =====');

  console.log('\n===== [1] 检查 Python 环境 =====');
  exec('python --version');

  console.log('\n===== [2] 安装 pre-commit =====');
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
  let repoPath = '';

  if (fs.existsSync(path.join(workspace, 'repo_workspace'))) {
    repoPath = path.join(workspace, 'repo_workspace');
    console.log(`[OK] 使用 repo_workspace: ${repoPath}`);
  } else {
    const gitDir = execCapture(`find ${workspace} -maxdepth 3 -name ".git" -type d 2>/dev/null | head -1`);
    if (gitDir) {
      repoPath = path.dirname(gitDir);
      console.log(`[OK] 通过 .git 定位: ${repoPath}`);
    }
  }

  if (!repoPath || !fs.existsSync(repoPath)) {
    console.log('[ERROR] 无法确定代码目录');
    setOutput('result', 'failed');
    process.exit(1);
  }

  process.chdir(repoPath);
  console.log(`代码目录: ${process.cwd()}`);

  console.log('\n===== [4] 检查 .pre-commit-config.yaml =====');
  if (!fs.existsSync('.pre-commit-config.yaml')) {
    console.log('[INFO] 未找到 .pre-commit-config.yaml，跳过 pre-commit 检查');
    setOutput('result', 'success');
    setOutput('checked_files', 'skipped');
    return;
  }
  console.log('[OK] 找到 .pre-commit-config.yaml');

  console.log('\n===== [5] 构建运行参数 =====');
  let cmdResult;
  if (extraArgs) {
    console.log(`[INFO] 检测到自定义参数: ${extraArgs}`);
    cmdResult = { type: 'args', value: extraArgs };
  } else {
    console.log('[INFO] 未指定参数，自动判断检查模式');
    cmdResult = buildAutoArgs();
  }
  if (cmdResult.type === 'args') {
    console.log(`最终参数: ${cmdResult.value}`);
  } else {
    console.log(`最终模式: 分批执行 (${cmdResult.count} 个文件，每批 30 个)`);
  }

  console.log('\n===== [6] 运行 pre-commit =====');
  const MAX_RETRIES = 3;
  let preCommitPassed = false;
  let failedFiles = [];
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      console.log(`\n[INFO] 第 ${attempt} 次重试...`);
    }
    const output = execCapture(`python -m pre_commit run ${cmdResult.type === 'file' ? '--all' : cmdResult.value} 2>&1; echo "EXIT_CODE:$?"`);
    console.log(output);
    const exitCodeMatch = output.match(/EXIT_CODE:(\d+)/);
    const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1]) : 1;
    const isNetworkError = /URLError|SSL:|UNEXPECTED_EOF|timed out|Connection refused|Could not resolve/i.test(output);
    if (exitCode === 0) {
      preCommitPassed = true;
      setOutput('result', 'success');
      break;
    }
    if (isNetworkError && attempt < MAX_RETRIES) {
      console.log(`[WARN] 检测到网络错误，将进行第 ${attempt + 1} 次重试...`);
      continue;
    }
    break;
  }
  if (!preCommitPassed) {
    setOutput('result', 'failed');
    try {
      const changedFiles = execCapture('git diff HEAD --name-only');
      if (changedFiles) {
        failedFiles = changedFiles.split('\n').filter(f => f.trim());
        console.log('===== 需要修改的文件 =====');
        failedFiles.forEach(f => console.log(`  - ${f}`));
        console.log('');
        const diffStat = execCapture('git diff HEAD --stat');
        if (diffStat) console.log(diffStat);
      } else {
        const fallbackFiles = execCapture('git diff --name-only');
        if (fallbackFiles) {
          failedFiles = fallbackFiles.split('\n').filter(f => f.trim());
          console.log('===== 需要修改的文件 =====');
          failedFiles.forEach(f => console.log(`  - ${f}`));
          console.log('');
          const fallbackStat = execCapture('git diff --stat');
          if (fallbackStat) console.log(fallbackStat);
        } else {
          console.log('[INFO] 未检测到文件修改（pre-commit 可能因环境错误而失败）');
        }
      }
    } catch (diffErr) {
      console.log(`[WARN] 获取 diff 失败: ${diffErr.message}`);
    }
  }

  console.log('\n================================================================');
  if (preCommitPassed) {
    console.log('[INFO] pre-commit 检查全部通过');
  } else {
    console.log('[ERROR] pre-commit 检查失败');
    console.log('[INFO] 请在本地执行以下命令修复后重新提交:');
    console.log('');
    console.log('1. 安装/初始化环境');
    console.log('   pip install pre-commit && pre-commit install --install-hooks');
    console.log('');
    console.log('2. 检查并修复变更文件');
    if (failedFiles.length > 0) {
      console.log(`   pre-commit run --files ${failedFiles.join(' ')}`);
    } else {
      console.log('   pre-commit run --all');
    }
  }
  console.log('================================================================');

  if (!preCommitPassed) {
    process.exit(1);
  }

  const checkedInfo = cmdResult.type === 'file' ? `batch:${cmdResult.count}files` : cmdResult.value;
  setOutput('checked_files', checkedInfo);
}

run().catch(err => {
  const sanitizedMessage = sanitizePath(err.message);
  console.error(`Action 执行失败: ${sanitizedMessage}`);
  setOutput('result', 'failed');
  process.exit(1);
});
