'use strict';

/**
 * resolveBaseRef 单测：PR 增量基线解析（不依赖任何网络与远端仓库）。
 *
 * 覆盖三条路径：
 *   1. checkout 全量检出已生成 origin/<baseRef> → 直接复用，不做 fetch
 *   2. origin/<baseRef> 缺失 → 回退 git fetch origin <baseRef>，返回 FETCH_HEAD
 *   3. 回退 fetch 失败 → 明确报错并 process.exit(1)
 *
 * 用本地 bare 仓充当 origin，保证用例可离线执行。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const { execFileSync } = require('child_process');

const { resolveBaseRef } = require('../index');

/** 在指定目录执行 git 并返回 stdout。 */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/** 构造 work 仓 + bare origin 仓，并把 main 推到 origin（生成 origin/main 远端跟踪 ref）。 */
function setupRepos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-baseref-'));
  const work = path.join(root, 'work');
  const bare = path.join(root, 'origin.git');
  fs.mkdirSync(work);
  git(root, ['init', '--bare', '-b', 'main', bare]);
  git(work, ['init', '-b', 'main']);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'test']);
  git(work, ['commit', '--allow-empty', '-m', 'init']);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', '-u', 'origin', 'main']);
  return { root, work, bare };
}

/** 切换工作目录执行 fn，结束后恢复，避免污染其他用例。 */
function inDir(dir, fn) {
  const orig = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(orig);
  }
}

/** 屏蔽被测函数打到控制台的过程日志。 */
function muteConsole(fn) {
  const origLog = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = origLog;
  }
}

test('resolveBaseRef：已检出 origin/<baseRef> 时直接复用，不发起 fetch', () => {
  const { root, work } = setupRepos();
  try {
    const fromRef = inDir(work, () => muteConsole(() => resolveBaseRef('main')));
    assert.strictEqual(fromRef, 'origin/main');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveBaseRef：基线 ref 缺失时回退 fetch，并返回 FETCH_HEAD', () => {
  const { root, work } = setupRepos();
  try {
    // 删除远端跟踪 ref，模拟 checkout 未做全量检出（fetch-depth: 0 缺失）
    git(work, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const fromRef = inDir(work, () => muteConsole(() => resolveBaseRef('main')));
    assert.strictEqual(fromRef, 'FETCH_HEAD');
    // 回退 fetch 成功后会重新生成远端跟踪 ref
    assert.ok(git(work, ['rev-parse', '--verify', '--quiet', 'origin/main']));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveBaseRef：回退 fetch 失败时输出 fetch-depth: 0 修复指引', () => {
  const { root, work } = setupRepos();
  const origExit = process.exit;
  const origLog = console.log;
  const logs = [];
  try {
    process.exit = () => {
      throw new Error('__EXIT__');
    };
    console.log = (line) => logs.push(String(line));
    assert.throws(
      () => inDir(work, () => resolveBaseRef('not-exist-branch')),
      /__EXIT__/
    );
    const output = logs.join('\n');
    assert.ok(output.includes('fetch-depth: 0'), '缺少 fetch-depth: 0 的修复指引');
    assert.ok(output.includes('gc_token'), '缺少 gc_token 已移除的说明');
  } finally {
    process.exit = origExit;
    console.log = origLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveBaseRef：回退 fetch 失败时报错并 exit(1)', () => {
  const { root, work } = setupRepos();
  const origExit = process.exit;
  let exitCode = null;
  try {
    process.exit = (code) => {
      exitCode = code;
      throw new Error('__EXIT__');
    };
    assert.throws(
      () => inDir(work, () => muteConsole(() => resolveBaseRef('not-exist-branch'))),
      /__EXIT__/
    );
    assert.strictEqual(exitCode, 1);
  } finally {
    process.exit = origExit;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
