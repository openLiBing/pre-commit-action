const test = require("node:test");
const assert = require("node:assert/strict");

const { parseGitleaks, matchToolParser } = require("../tool-parsers");

test("parseGitleaks 将 gitleaks 告警行解析为 SARIF 前置结构，并能按钩子 id 匹配解析器", () => {
  const findings = parseGitleaks([
    "○ [generic-api-key] Generic API Key in src/app.js:12",
    "RuleID: aws-access-token",
    "File: config/settings.js",
    "Line: 34",
    "Secret: AKIA****",
  ]);

  assert.equal(findings.length, 2);

  const first = findings[0];
  assert.equal(first.ruleId, "generic-api-key");
  assert.equal(first.message, "Generic API Key");
  assert.equal(first.file, "src/app.js");
  assert.equal(first.line, 12);
  assert.equal(first.helpUri, "https://github.com/gitleaks/gitleaks");

  const second = findings[1];
  assert.equal(second.ruleId, "aws-access-token");
  assert.equal(second.file, "config/settings.js");
  assert.equal(second.line, 34);

  assert.equal(matchToolParser("gitleaks").toolName, "gitleaks");
  assert.equal(matchToolParser("not-a-hook"), null);
});
