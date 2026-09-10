'use strict';

/**
 * pre-commit 扫描报告 → SARIF 2.1.0 转换器。
 *
 * 纯函数模块（无 IO），便于单元测试与独立复用。
 * 支持两种工具的 JSON 报告：
 *   - gitleaks（--report-format json 产出的 findings 数组）：
 *     [{ RuleID, Description, StartLine, EndLine, StartColumn, EndColumn,
 *        Match, Secret, File, Commit, Entropy, Author, Email, Date, Message, Tags }]
 *   - detect-secrets（scan 输出的对象）：
 *     { generated_at, plugins_used: [{name,...}], version,
 *       results: { <file>: [{type, filename, hashed_secret, is_verified, line_number}] } }
 * 输出为符合 SARIF 2.1.0 规范的扫描结果对象。
 */

/** 构造单个 rule 对象（同一 RuleID 去重）。 */
function _buildRules(findings) {
  const rules = [];
  const seen = new Set();
  for (const f of findings) {
    if (!f.RuleID || seen.has(f.RuleID)) {
      continue;
    }
    seen.add(f.RuleID);
    rules.push({
      id: f.RuleID,
      name: f.RuleID,
      shortDescription: { text: f.Description || `gitleaks rule: ${f.RuleID}` },
      fullDescription: { text: f.Description || `gitleaks rule: ${f.RuleID}` },
      properties: { tags: f.Tags || [] }
    });
  }
  return rules;
}

/** 构造单个 result 对象（冗余字段放入 properties 保留原始信息）。 */
function _buildResult(f) {
  const result = {
    ruleId: f.RuleID,
    level: 'error',
    message: { text: f.Description || `检测到敏感信息泄露：${f.RuleID}` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: f.File || 'unknown' },
          region: {
            startLine: f.StartLine || 1,
            startColumn: f.StartColumn || 1,
            endLine: f.EndLine || f.StartLine || 1,
            endColumn: f.EndColumn || f.StartColumn || 1
          }
        }
      }
    ]
  };

  const props = {};
  if (f.Secret) props.secret = f.Secret;
  if (f.Match) props.match = f.Match;
  if (f.Commit) props.commit = f.Commit;
  if (f.Author) props.author = f.Author;
  if (f.Email) props.email = f.Email;
  if (f.Date) props.date = f.Date;
  if (f.Message) props.message = f.Message;
  if (f.Entropy !== undefined && f.Entropy !== null) props.entropy = f.Entropy;
  if (f.Tags && f.Tags.length > 0) props.tags = f.Tags;
  if (Object.keys(props).length > 0) {
    result.properties = props;
  }
  return result;
}

/**
 * 将 gitleaks findings 数组转换为 SARIF 2.1.0 对象。
 * @param {Array} findings gitleaks JSON 报告内容（findings 数组）
 * @param {Object} [opts]
 * @param {string} [opts.toolVersion] gitleaks 版本号，写入 tool.driver.version
 * @returns {Object} SARIF 2.1.0 对象
 * @throws {Error} findings 不是数组时抛出
 */
function convertGitleaksToSarif(findings, opts = {}) {
  if (!Array.isArray(findings)) {
    throw new Error('gitleaks 报告格式不正确：应为 JSON 数组（findings）');
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'gitleaks',
            version: opts.toolVersion || '',
            informationUri: 'https://github.com/gitleaks/gitleaks',
            rules: _buildRules(findings)
          }
        },
        results: findings.filter(f => f && f.RuleID).map(_buildResult)
      }
    ]
  };
}

/**
 * 将 detect-secrets JSON 报告转换为 SARIF 2.1.0 对象。
 * @param {Object} report detect-secrets scan 输出（含 results 对象）
 * @param {Object} [opts]
 * @param {string} [opts.toolVersion] 覆盖 tool.driver.version
 * @returns {Object} SARIF 2.1.0 对象
 * @throws {Error} 报告缺少 results 对象时抛出
 */
function convertDetectSecretsToSarif(report, opts = {}) {
  if (!report || typeof report !== 'object' || !report.results || typeof report.results !== 'object') {
    throw new Error('detect-secrets 报告格式不正确：应为包含 results 对象的 JSON');
  }

  // 收集全部 secret 与去重后的检测类型（ruleId 使用检测类型，与 rules 一一对应）
  const typeSet = new Set();
  const secretList = [];
  for (const [file, secrets] of Object.entries(report.results)) {
    for (const s of Array.isArray(secrets) ? secrets : []) {
      if (!s || typeof s !== 'object') {
        continue;
      }
      if (s.type) {
        typeSet.add(s.type);
      }
      secretList.push({ file, secret: s });
    }
  }

  const rules = [...typeSet].map((t) => ({
    id: t,
    name: t,
    shortDescription: { text: `detect-secrets: ${t}` },
    fullDescription: { text: `detect-secrets 检测类型：${t}` }
  }));

  const results = secretList.map(({ file, secret: s }) => {
    const type = s.type || 'Secret';
    const line = s.line_number || 1;
    const result = {
      ruleId: type,
      level: s.is_verified ? 'error' : 'warning',
      message: { text: `在 ${file} 第 ${line} 行检测到 ${type}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: file },
            region: { startLine: line }
          }
        }
      ]
    };

    const props = {};
    if (s.hashed_secret) props.hashedSecret = s.hashed_secret;
    if (typeof s.is_verified === 'boolean') props.isVerified = s.is_verified;
    if (s.filename) props.filename = s.filename;
    if (Object.keys(props).length > 0) {
      result.properties = props;
    }
    return result;
  });

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'detect-secrets',
            version: opts.toolVersion || report.version || '',
            informationUri: 'https://github.com/Yelp/detect-secrets',
            rules
          }
        },
        results
      }
    ]
  };
}

module.exports = { convertGitleaksToSarif, convertDetectSecretsToSarif };
