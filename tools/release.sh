#!/usr/bin/env bash
#
# 发版辅助脚本：同步版本号、提交、打 tag 并推送。
# 推送 tag 后 GitHub Actions 会自动跑测试、打包并创建 Release。
#
# 用法：
#   bash tools/release.sh 0.2.0
#
set -euo pipefail

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "用法：bash tools/release.sh <版本号>，例如 bash tools/release.sh 0.2.0"
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "版本号必须是 x.y.z 格式，收到：$VERSION"
  exit 1
fi

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交的改动，请先提交或 stash："
  git status --short
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "当前分支是 $CURRENT_BRANCH，发版请在 main 上操作。"
  exit 1
fi

echo "==> 更新版本号到 $VERSION"
node -e "
const fs = require('fs');
for (const file of ['manifest.json', 'package.json']) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.version = process.argv[1];
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  console.log('   ' + file);
}
" "$VERSION"

echo "==> 校验"
node tools/check-manifest.js
npm test

echo "==> 更新 CHANGELOG"
if ! grep -q "## \[$VERSION\]" CHANGELOG.md; then
  TODAY="$(date +%Y-%m-%d)"
  node -e "
const fs = require('fs');
const version = process.argv[1];
const today = process.argv[2];
let text = fs.readFileSync('CHANGELOG.md', 'utf8');
const at = text.indexOf('## [');
const entry = '## [' + version + '] - ' + today + '\n\n### 变更\n\n- \n\n';
text = at === -1 ? text + '\n' + entry : text.slice(0, at) + entry + text.slice(at);
fs.writeFileSync('CHANGELOG.md', text);
" "$VERSION" "$TODAY"
  echo "   已插入 CHANGELOG 条目，请补充变更内容后再继续（脚本已暂停）"
  echo "   补完后手动执行：git add -A && git commit -m 'chore: release $VERSION' && git tag v$VERSION && git push origin main --tags"
  exit 0
fi

echo "==> 提交并打 tag"
git add -A
git commit -m "chore: release $VERSION"
git tag "v$VERSION"

echo "==> 推送"
git push origin main
git push origin "v$VERSION"

echo
echo "完成。GitHub Actions 会自动测试、打包并创建 Release："
echo "  https://github.com/$(git remote get-url origin | sed -E 's#.*[:/]([^/]+/[^/]+?)(\.git)?$#\1#')/actions"
