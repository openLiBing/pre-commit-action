const fs = require('fs');
const path = require('path');

const actionYmlPath = path.join(__dirname, 'action.yml');

let content = fs.readFileSync(actionYmlPath, 'utf8');

// 兼容带引号/不带引号两种写法（Ref issue #32：action.yml 当前 version 无引号，旧正则必然匹配失败）
const versionMatch = content.match(/version:\s*(['"]?)([\d.]+)\1/);
if (versionMatch) {
  const currentVersion = versionMatch[2];
  const quote = versionMatch[1];
  const parts = currentVersion.split('.').map(Number);
  parts[2] = (parts[2] || 0) + 1;
  const newVersion = parts.join('.');
  content = content.replace(/version:\s*(['"]?)[\d.]+\1/, `version: ${quote}${newVersion}${quote}`);
  fs.writeFileSync(actionYmlPath, content, 'utf8');
  console.log(`Version bumped from ${currentVersion} to ${newVersion}`);
} else {
  console.log('Version not found in action.yml');
  process.exit(1);
}
