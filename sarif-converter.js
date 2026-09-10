'use strict';

/**
 * gitleaks JSON 报告 → SARIF 2.1.0 转换器。
 *
 * 纯函数模块（无 IO），便于单元测试与独立复用。
 * 输入为 gitleaks --report-format json 产出的 findings 数组：
 *   [{ RuleID, Description, StartLine, EndLine, StartColumn, EndColumn,
 *      Match, Secret, File, Commit, Entropy, Author, Email, Date, Message, Tags }]
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

module.exports = { convertGitleaksToSarif };
