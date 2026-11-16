'use strict';

/**
 * resolveBaseRef 单测：PR 增量基线解析（不依赖任何网络与远端仓库）。
 *
 * 覆盖五条路径：
 *   1. checkout 全量检出已生成 origin/<baseRef> → 直接复用，不做 fetch
 *   2. origin/<baseRef> 缺失 → 回退 git fetch origin <baseRef>，返回 FETCH_HEAD
 *   3. 回退 fetch 失败 → 明确报错并 process.exit(1)
 *   4. 浅克隆命中 ref → 输出浅历史提示，提示配置 fetch-depth: 0
 *   5. 缺失基线 ref 但存量调用方传入 gc_token → 走兼容路径并打印 [DEPRECATED]
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
    assert.ok(output.includes('gc_token'), '缺少 gc_token 兼容/废弃说明');
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

test('resolveBaseRef：浅克隆命中 ref 时提示配置 fetch-depth: 0', () => {
  const { root, bare } = setupRepos();
  try {
    const cloneDir = path.join(root, 'shallow');
    // --depth 需配合 file:// 协议才会真正产生浅克隆
    git(root, ['clone', '--depth', '1', `file:///${bare.replace(/\\/g, '/')}`, cloneDir]);
    const logs = [];
    const origLog = console.log;
    let fromRef;
    try {
      console.log = (line) => logs.push(String(line));
      fromRef = inDir(cloneDir, () => resolveBaseRef('main'));
    } finally {
      console.log = origLog;
    }
    assert.strictEqual(fromRef, 'origin/main');
    const output = logs.join('\n');
    assert.ok(output.includes('浅克隆'), '缺少浅克隆提示');
    assert.ok(output.includes('fetch-depth: 0'), '缺少 fetch-depth: 0 提示');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveBaseRef：缺失基线 ref 但传入 gc_token 时走兼容路径并打印废弃警告', () => {
  const { root, work } = setupRepos();
  const origToken = process.env.INPUT_GC_TOKEN;
  const logs = [];
  const origLog = console.log;
  try {
    process.env.INPUT_GC_TOKEN = 'fake-token-for-compat';
    git(work, ['update-ref', '-d', 'refs/remotes/origin/main']);
    let fromRef;
    try {
      console.log = (line) => logs.push(String(line));
      fromRef = inDir(work, () => resolveBaseRef('main'));
    } finally {
      console.log = origLog;
    }
    assert.strictEqual(fromRef, 'FETCH_HEAD');
    assert.ok(logs.join('\n').includes('[DEPRECATED]'), '缺少 gc_token 废弃警告');
  } finally {
    if (origToken === undefined) {
      delete process.env.INPUT_GC_TOKEN;
    } else {
      process.env.INPUT_GC_TOKEN = origToken;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
