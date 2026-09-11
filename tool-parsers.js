'use strict';

/**
 * pre-commit 失败日志按工具解析（兜底 SARIF 数据源）。
 * 第一批支持：clang-tidy / bandit / gosec / spotbugs / rust-clippy / eslint / gitleaks / detect-secrets。
 * 每种工具实现一个行解析器：输入失败钩子的输出块行（trimmed 非空），输出结构化 findings。
 * 供 pre-commit-action 在用户未提供 *.sarif 时生成 <tool>.sarif。
 */

const crypto = require('crypto');

const LEVEL_ERROR = 'error';
const LEVEL_WARNING = 'warning';
const LEVEL_NOTE = 'note';

/** sha256 稳定指纹（后端 StandardSarifParser 用 partialFingerprints.primaryLocationLineHash 构建 fingerprintKey）。 */
function _locationHash(toolName, ruleId, file, line, column) {
  const raw = [toolName, ruleId, file || '', line || '', column || ''].join('|');
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** 由 findings 构建 SARIF 2.1.0（rules 去重，每个 finding 一个 result）。 */
function buildToolSarif(toolName, findings) {
  const rules = [];
  const ruleMap = {};
  const results = [];
  for (const f of findings) {
    const ruleId = f.ruleId || toolName;
    if (!ruleMap[ruleId]) {
      ruleMap[ruleId] = true;
      rules.push({
        id: ruleId,
        name: ruleId,
        shortDescription: { text: f.ruleDesc || ruleId },
        helpUri: f.helpUri || ''
      });
    }
    const region = {};
    if (f.line) region.startLine = f.line;
    if (f.column) region.startColumn = f.column;
    results.push({
      ruleId,
      level: f.level || LEVEL_ERROR,
      message: { text: f.message || ruleId },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: f.file || toolName },
          region
        }
      }],
      partialFingerprints: {
        primaryLocationLineHash: _locationHash(toolName, ruleId, f.file, f.line, f.column)
      }
    });
  }
  if (rules.length === 0) return null;
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: {
        driver: {
          name: toolName,
          rules
        }
      },
      results
    }]
  };
}

/** clang-tidy：path:line[:col]: warning|error|note: message [rule-id] */
function parseClangTidy(lines) {
  const findings = [];
  // 非贪婪匹配路径段，避免 path:line:col 三段时行号被吞进 file（贪婪会匹配到最后一个冒号前的 ":line"）
  const re = /^(.+?):(\d+)(?::(\d+))?:\s*(warning|error|note):\s*(.+?)\s*(?:\[([^\]]+)\])?$/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const lvl = m[4];
    findings.push({
      ruleId: m[6] || 'clang-tidy',
      ruleDesc: m[6] || 'clang-tidy diagnostic',
      level: lvl === 'error' ? LEVEL_ERROR : (lvl === 'warning' ? LEVEL_WARNING : LEVEL_NOTE),
      message: m[5],
      file: m[1],
      line: parseInt(m[2], 10),
      column: m[3] ? parseInt(m[3], 10) : undefined,
      helpUri: 'https://clang.llvm.org/extra/clang-tidy/'
    });
  }
  return findings;
}

/** bandit：多行格式（>> Issue / Severity / Location）或单行格式（Issue: [B1xx:id] msg in file x at line n） */
function parseBandit(lines) {
  const findings = [];
  let cur = null;
  for (const line of lines) {
    let m = line.match(/^>>\s*Issue:\s*\[([A-Z]\d+):([\w\-]+)\]\s*(.+)$/);
    if (m) {
      cur = { ruleId: m[1], ruleDesc: m[2], message: m[3], severity: '' };
      findings.push(cur);
      continue;
    }
    if (!cur) continue;
    m = line.match(/^Severity:\s*(\w+)/);
    if (m) { cur.severity = m[1]; continue; }
    m = line.match(/^Location:\s*(.+):(\d+)(?::(\d+))?/);
    if (m) {
      cur.file = m[1];
      cur.line = parseInt(m[2], 10);
      cur.column = m[3] ? parseInt(m[3], 10) : undefined;
      continue;
    }
  }
  // 单行格式
  for (const line of lines) {
    const m = line.match(/^Issue:\s*\[([A-Z]\d+):([\w\-]+)\]\s*(.+?)\s+in file\s+(\S+)\s+at line\s+(\d+)/);
    if (m) {
      findings.push({
        ruleId: m[1],
        ruleDesc: m[2],
        message: m[3],
        severity: '',
        file: m[4],
        line: parseInt(m[5], 10)
      });
    }
  }
  return findings.map(f => ({
    ...f,
    level: f.severity === 'High' ? LEVEL_ERROR : LEVEL_WARNING,
    helpUri: 'https://bandit.readthedocs.io/'
  }));
}

/** gosec：[path:line] - GXXX: message (Confidence: X, Severity: X) */
function parseGosec(lines) {
  const findings = [];
  const re = /^\[(.+):(\d+)\]\s*-\s*([A-Z]\d+):\s*(.+?)\s*\(Confidence: \w+, Severity: (\w+)\)/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const severity = m[5];
    findings.push({
      ruleId: m[3],
      ruleDesc: m[3],
      message: m[4],
      level: severity === 'MEDIUM' || severity === 'HIGH' ? LEVEL_ERROR : LEVEL_WARNING,
      file: m[1],
      line: parseInt(m[2], 10),
      helpUri: 'https://github.com/securego/gosec'
    });
  }
  return findings;
}

/** SpotBugs（-textui 默认格式）：H|M|L CATEGORY TYPE: message  In class X  In method Y  At File.java:[line n] */
function parseSpotbugs(lines) {
  const findings = [];
  // 格式：M DLS_DEAD_LOCAL_STORE: message  In class Foo  In method bar  At Foo.java:[line 10]
  const re = /^([HML])\s+([\w\.]+):\s*(.+?)\s+In class\s+(\S+)\s+In method\s+(.+?)\s+At\s+(\S+):\[line\s+(\d+)(?:-(\d+))?\]/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    findings.push({
      ruleId: m[2],
      ruleDesc: m[2],
      message: m[3],
      level: m[1] === 'H' ? LEVEL_ERROR : LEVEL_WARNING,
      file: m[6],
      line: parseInt(m[7], 10),
      helpUri: 'https://spotbugs.readthedocs.io/'
    });
  }
  return findings;
}

/** rust-clippy（cargo clippy 格式）：warning|error: message + "  --> path:line:col" + "= note: `#[warn(clippy::x)]`" */
function parseClippy(lines) {
  const findings = [];
  let cur = null;
  const startRe = /^(warning|error|note):\s*(.+)$/;
  const locRe = /^-->\s*(.+):(\d+):(\d+)/;
  const noteRe = /^= note:\s*`#\[warn\(([\w:]+)\)\]/;
  for (const line of lines) {
    const m = line.match(startRe);
    if (m) {
      cur = {
        ruleId: 'clippy',
        ruleDesc: 'clippy lint',
        message: m[2],
        level: m[1] === 'error' ? LEVEL_ERROR : (m[1] === 'warning' ? LEVEL_WARNING : LEVEL_NOTE)
      };
      findings.push(cur);
      continue;
    }
    if (!cur) continue;
    const nm = line.match(noteRe);
    if (nm) { cur.ruleId = nm[1]; cur.ruleDesc = nm[1]; continue; }
    const lm = line.match(locRe);
    if (lm) {
      cur.file = lm[1];
      cur.line = parseInt(lm[2], 10);
      cur.column = parseInt(lm[3], 10);
    }
  }
  return findings.map(f => ({ ...f, helpUri: 'https://rust-lang.github.io/rust-clippy/' }));
}

/** ESLint（stylish 格式）：文件头行 + "  line:col  error|warning  message  rule-id" */
function parseEslint(lines) {
  const findings = [];
  let currentFile = '';
  const resultRe = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+([\w\-\.\/\\@]+)\s*$/;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(resultRe);
    if (m) {
      findings.push({
        ruleId: m[5],
        ruleDesc: m[5],
        message: m[4],
        level: m[3] === 'error' ? LEVEL_ERROR : LEVEL_WARNING,
        file: currentFile,
        line: parseInt(m[1], 10),
        column: parseInt(m[2], 10),
        helpUri: 'https://eslint.org/'
      });
      continue;
    }
    // 文件头：非结果行、非统计行（如 "✖ 2 problems" / "N problems"）、非缩进行
    if (!/^\s*\d+:\d+/.test(line) && !/^✖/.test(line) && !/^\d+\s+problems/.test(line) && !line.startsWith(' ')) {
      currentFile = line.trim();
    }
  }
  return findings;
}

/** gitleaks：单行 "○  [rule] msg in file:line" 或多行 Finding（RuleID/File/Line/Secret/Description） */
function parseGitleaks(lines) {
  const findings = [];
  const singleRe = /^○\s*\[([\w\-]+)\]\s*(.+?)\s+in\s+(\S+):(\d+)/;
  let cur = null;
  for (const line of lines) {
    const m = line.match(singleRe);
    if (m) {
      findings.push({
        ruleId: m[1],
        ruleDesc: m[1],
        message: m[2],
        level: LEVEL_ERROR,
        file: m[3],
        line: parseInt(m[4], 10)
      });
      cur = null;
      continue;
    }
    let f = line.match(/^RuleID:\s*(\S+)/);
    if (f) {
      cur = { ruleId: f[1], ruleDesc: f[1], message: '', level: LEVEL_ERROR };
      findings.push(cur);
      continue;
    }
    if (!cur) continue;
    f = line.match(/^(File|Line|Secret|Finding|Description|Match):\s*(.+)/);
    if (f) {
      const k = f[1];
      const v = f[2].trim();
      if (k === 'File') cur.file = v;
      else if (k === 'Line') cur.line = parseInt(v, 10);
      else if (k === 'Secret' || k === 'Match') cur.message = (cur.message ? cur.message + ' ' : '') + v.slice(0, 60);
      else if (k === 'Description' || k === 'Finding') cur.message = cur.message || v;
    }
  }
  return findings.map(f => ({ ...f, helpUri: 'https://github.com/gitleaks/gitleaks' }));
}

/** detect-secrets（detect-secrets-hook 输出）："Secret Type: X" + "Location:    file:line" 成对格式 */
function parseDetectSecrets(lines) {
  const findings = [];
  let cur = null;
  const typeRe = /^Secret Type:\s*(.+)$/;
  const locRe = /^Location:\s*(\S+):(\d+)(?::(\d+))?/;
  for (const line of lines) {
    const m = line.match(typeRe);
    if (m) {
      const type = m[1].trim();
      cur = {
        ruleId: type,
        ruleDesc: type,
        message: `Potential secret detected: ${type}`,
        level: LEVEL_ERROR
      };
      findings.push(cur);
      continue;
    }
    if (!cur) continue;
    const lm = line.match(locRe);
    if (lm) {
      cur.file = lm[1];
      cur.line = parseInt(lm[2], 10);
      cur.column = lm[3] ? parseInt(lm[3], 10) : undefined;
    }
  }
  return findings.map(f => ({ ...f, helpUri: 'https://github.com/Yelp/detect-secrets' }));
}

/** 工具映射表：hook id（小写）→ 解析器。 */
const TOOL_PARSERS = [
  { toolName: 'clang-tidy', hooks: ['clang-tidy', 'clang_tidy'], parse: parseClangTidy },
  { toolName: 'bandit', hooks: ['bandit'], parse: parseBandit },
  { toolName: 'gosec', hooks: ['gosec'], parse: parseGosec },
  { toolName: 'spotbugs', hooks: ['spotbugs', 'spot-bugs'], parse: parseSpotbugs },
  { toolName: 'rust-clippy', hooks: ['rust-clippy', 'rust_clippy', 'clippy'], parse: parseClippy },
  { toolName: 'eslint', hooks: ['eslint'], parse: parseEslint },
  { toolName: 'gitleaks', hooks: ['gitleaks'], parse: parseGitleaks },
  { toolName: 'detect-secrets', hooks: ['detect-secrets', 'detect-secrets-report'], parse: parseDetectSecrets }
];

/** 按失败钩子 id 匹配工具解析器；未支持的工具返回 null。 */
function matchToolParser(hookId) {
  const id = String(hookId || '').toLowerCase();
  for (const t of TOOL_PARSERS) {
    if (t.hooks.includes(id)) return t;
  }
  return null;
}

module.exports = {
  buildToolSarif,
  matchToolParser,
  parseClangTidy,
  parseBandit,
  parseGosec,
  parseSpotbugs,
  parseClippy,
  parseEslint,
  parseGitleaks,
  parseDetectSecrets,
  TOOL_PARSERS
};
