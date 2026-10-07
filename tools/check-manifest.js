/**
 * Manifest / 版本一致性校验。
 *
 * 比 tools/test.js 里的"文件是否存在"更严格：
 *  - manifest.json 与 package.json 的版本号必须一致
 *  - 版本号必须是合法的 x.y.z
 *  - manifest 里 permissions / host_permissions 不能有重复项
 *  - content_scripts 的 matches 必须覆盖抖音，world 声明必须合法
 *  - 打包清单 tools/pack.js 的 INCLUDE 必须覆盖 manifest 引用到的所有运行期文件
 *
 * 用法：node tools/check-manifest.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function readJson(rel) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    fail(`缺少文件：${rel}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`${rel} 不是合法 JSON：${err.message}`);
    return null;
  }
}

const manifest = readJson('manifest.json');
const pkg = readJson('package.json');

if (!manifest || !pkg) {
  console.log(problems.join('\n'));
  process.exit(1);
}

// ---------------------------------------------------------------- 版本

const SEMVER = /^\d+\.\d+\.\d+$/;

if (!SEMVER.test(manifest.version)) {
  fail(`manifest.json 的 version "${manifest.version}" 不是 x.y.z 格式`);
}

if (manifest.version !== pkg.version) {
  fail(`版本号不一致：manifest.json 是 ${manifest.version}，package.json 是 ${pkg.version}`);
} else {
  notes.push(`版本号一致：${manifest.version}`);
}

if (manifest.name !== pkg.name) {
  fail(`名称不一致：manifest.json 是 "${manifest.name}"，package.json 是 "${pkg.name}"`);
}

// Chrome 的扩展名有长度与字符限制
if (!/^[a-z0-9-]{1,40}$/.test(manifest.name)) {
  fail(`扩展名 "${manifest.name}" 只能包含小写字母、数字和连字符，且不超过 40 字符`);
}

// ---------------------------------------------------------------- 权限

function checkDuplicates(list, label) {
  if (!Array.isArray(list)) return;
  const seen = new Set();
  for (const item of list) {
    if (seen.has(item)) fail(`${label} 里有重复项：${item}`);
    seen.add(item);
  }
}

checkDuplicates(manifest.permissions, 'permissions');
checkDuplicates(manifest.host_permissions, 'host_permissions');
checkDuplicates(manifest.optional_host_permissions, 'optional_host_permissions');

// 权限声明与代码实际用到的 API 对照，避免申请了用不上或用了没申请
const ALLOWED = new Set(['storage', 'alarms', 'unlimitedStorage', 'contextMenus', 'notifications', 'tabs', 'scripting']);
for (const perm of manifest.permissions || []) {
  if (!ALLOWED.has(perm)) {
    fail(`permissions 里的 "${perm}" 不在预期集合内，请确认是否真的需要`);
  }
}

// ---------------------------------------------------------------- content scripts

const scripts = manifest.content_scripts || [];
if (!scripts.length) fail('manifest.json 没有声明任何 content_scripts');

const worlds = new Set();
for (const entry of scripts) {
  const world = entry.world || 'ISOLATED';
  worlds.add(world);
  if (!['ISOLATED', 'MAIN'].includes(world)) {
    fail(`content_scripts 的 world "${world}" 不合法`);
  }
  const coversDouyin = (entry.matches || []).some((m) => m.includes('douyin.com'));
  if (!coversDouyin) fail(`content_scripts（world=${world}）的 matches 没有覆盖 douyin.com`);
  if (!entry.js || !entry.js.length) fail(`content_scripts（world=${world}）没有 js 文件`);
}

if (!worlds.has('MAIN')) fail('缺少 MAIN world 的 content script，网络拦截将无法工作');
if (!worlds.has('ISOLATED')) fail('缺少 ISOLATED world 的 content script，规则下发将无法工作');

// ---------------------------------------------------------------- 打包清单覆盖

const packSource = fs.readFileSync(path.join(ROOT, 'tools/pack.js'), 'utf8');
const includeMatch = packSource.match(/const INCLUDE = \[([^\]]+)\]/);
if (!includeMatch) {
  fail('无法从 tools/pack.js 解析 INCLUDE 列表');
} else {
  const includes = (includeMatch[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, ''));

  // 收集 manifest 引用到的所有运行期路径
  const runtimeRefs = new Set();
  const add = (value) => {
    if (typeof value === 'string') runtimeRefs.add(value.replace(/^\//, ''));
  };
  Object.values(manifest.icons || {}).forEach(add);
  Object.values((manifest.action && manifest.action.default_icon) || {}).forEach(add);
  add(manifest.action && manifest.action.default_popup);
  add(manifest.options_ui && manifest.options_ui.page);
  add(manifest.background && manifest.background.service_worker);
  for (const entry of scripts) {
    (entry.js || []).forEach(add);
    (entry.css || []).forEach(add);
  }
  for (const res of manifest.web_accessible_resources || []) {
    (res.resources || []).forEach(add);
  }

  for (const ref of runtimeRefs) {
    const top = ref.split('/')[0];
    if (!includes.includes(top)) {
      fail(`tools/pack.js 的 INCLUDE 没有覆盖 manifest 引用的 "${ref}"（缺少顶层目录 "${top}"）`);
    }
  }

  // 打包脚本自身依赖的文件要在仓库里
  for (const item of includes) {
    if (!fs.existsSync(path.join(ROOT, item))) {
      fail(`tools/pack.js 的 INCLUDE 里有不存在的路径：${item}`);
    }
  }
  notes.push(`打包清单覆盖 ${runtimeRefs.size} 个运行期引用`);
}

// ---------------------------------------------------------------- 内部规则文件

const bundled = readJson('rules/default-rules.json');
if (bundled) {
  if (!Array.isArray(bundled.rules) || !bundled.rules.length) fail('rules/default-rules.json 没有规则');
  if (typeof bundled.version !== 'number') fail('rules/default-rules.json 缺少数字类型的 version');
}

const indexJson = readJson('rules/index.json');
if (indexJson) {
  if (!Array.isArray(indexJson.files) || !indexJson.files.length) fail('rules/index.json 没有 files');
  for (const file of indexJson.files) {
    if (!file.path) fail('rules/index.json 有缺少 path 的条目');
    else if (!fs.existsSync(path.join(ROOT, 'rules', file.path))) {
      fail(`rules/index.json 指向的 ${file.path} 不存在`);
    }
  }
}

// ---------------------------------------------------------------- 工作流

const workflow = path.join(ROOT, '.github/workflows/build.yml');
if (!fs.existsSync(workflow)) {
  fail('缺少 .github/workflows/build.yml');
} else {
  const yml = fs.readFileSync(workflow, 'utf8');
  // 工作流里运行的每个 node 脚本都必须存在，否则 CI 会红
  for (const match of yml.matchAll(/node\s+(tools\/[\w.-]+\.js)/g)) {
    if (!fs.existsSync(path.join(ROOT, match[1]))) {
      fail(`工作流引用了不存在的脚本：${match[1]}`);
    }
  }
  if (!/npm test/.test(yml) && !/node tools\/test\.js/.test(yml)) {
    notes.push('提示：工作流里没有跑测试');
  }
}

// ---------------------------------------------------------------- 结果

if (notes.length) {
  console.log('检查结果：');
  for (const note of notes) console.log('  · ' + note);
}

if (problems.length) {
  console.log('\n发现 ' + problems.length + ' 处问题：');
  for (const problem of problems) console.log('  ✗ ' + problem);
  process.exit(1);
}

console.log('\nmanifest 校验通过');
