/**
 * douyin-plus 规则引擎自测（无第三方依赖）
 * 用法：node tools/test.js
 *
 * matcher.js / schema.js 是挂在 globalThis 上的 IIFE，这里用 vm 在沙箱里加载，
 * 尽量贴近它们在 content script 里的真实运行环境。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

function loadInto(sandbox, relative) {
  const code = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  vm.runInContext(code, sandbox, { filename: relative });
}

function makeSandbox() {
  const sandbox = { console, setTimeout, clearTimeout, URL, crypto: require('crypto').webcrypto };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  loadInto(sandbox, 'src/common/matcher.js');
  loadInto(sandbox, 'src/common/schema.js');
  return sandbox;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('    ' + (err && err.message ? err.message : String(err)));
  }
}

function section(title) {
  console.log('\n' + title);
}

/** 跨 vm realm 的对象不能用 deepStrictEqual 比较原型，这里比 JSON 形状 */
function sameShape(actual, expected) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected));
}

const sandbox = makeSandbox();
const matcher = sandbox.DouyinPlus.matcher;
const schema = sandbox.DouyinPlus.schema;

// ------------------------------------------------------------------ matcher

section('matcher: 关键词');

test('单关键词命中', () => {
  const m = matcher.createMatcher([{ pattern: '加微信', type: 'keyword', enabled: true }], 'comment');
  assert.ok(m.test('快来加微信吧'));
  assert.strictEqual(m.test('正常评论内容'), null);
});

test('一条规则多个关键词（换行/逗号分隔）', () => {
  const m = matcher.createMatcher([{ pattern: '刷单\n兼职，日结', type: 'keyword' }]);
  assert.ok(m.test('招人刷单'));
  assert.ok(m.test('兼职的来'));
  assert.ok(m.test('日结工资'));
  assert.strictEqual(m.test('今天天气不错'), null);
});

test('关键词按字面量处理，特殊字符不当正则', () => {
  const m = matcher.createMatcher([{ pattern: '1+1=2?', type: 'keyword' }]);
  assert.ok(m.test('答案是 1+1=2?')); 
  assert.strictEqual(m.test('1 1 2'), null);
});

test('默认忽略大小写，可开启区分', () => {
  const loose = matcher.createMatcher([{ pattern: 'wx', type: 'keyword', caseSensitive: false }]);
  assert.ok(loose.test('加WX'));
  const strict = matcher.createMatcher([{ pattern: 'wx', type: 'keyword', caseSensitive: true }]);
  assert.strictEqual(strict.test('加WX'), null);
  assert.ok(strict.test('加wx'));
});

test('停用的规则不参与匹配', () => {
  const m = matcher.createMatcher([{ pattern: '屏蔽我', type: 'keyword', enabled: false }]);
  assert.strictEqual(m.size, 0);
  assert.strictEqual(m.test('屏蔽我'), null);
});

test('targets 关闭时不参与该场景', () => {
  const rule = { pattern: '只在评论生效', type: 'keyword', targets: { comment: true, danmaku: false } };
  assert.ok(matcher.createMatcher([rule], 'comment').test('只在评论生效'));
  assert.strictEqual(matcher.createMatcher([rule], 'danmaku').size, 0);
  assert.strictEqual(matcher.createMatcher([rule], 'danmaku').test('只在评论生效'), null);
});

test('targets 数组与 "all" 写法兼容', () => {
  const rule = { pattern: 'x1', type: 'keyword', targets: ['danmaku', 'live'] };
  assert.ok(matcher.createMatcher([rule], 'danmaku').size);
  assert.ok(matcher.createMatcher([rule], 'live').size);
  assert.strictEqual(matcher.createMatcher([rule], 'comment').size, 0);
  const all = schema.normalizeRule({ pattern: 'x2', type: 'keyword', targets: 'all' });
  sameShape(all.targets, { danmaku: true, comment: true, live: true });
  const none = schema.normalizeRule({ pattern: 'x3', type: 'keyword', targets: { comment: true } });
  sameShape(none.targets, { danmaku: false, comment: true, live: false });
});

section('matcher: 正则');

test('正则规则命中', () => {
  const m = matcher.createMatcher([{ pattern: '1[3-9]\\d{9}', type: 'regex' }]);
  assert.ok(m.test('联系我 13812345678'));
});

test('裸正则会命中更长数字串，所以规则里应加边界（内置规则已加）', () => {
  const bare = matcher.createMatcher([{ pattern: '1[3-9]\\d{9}', type: 'regex' }]);
  assert.ok(bare.test('订单号 138123456789012'), '裸正则确实会命中长数字串');
  const bounded = matcher.createMatcher([{ pattern: '(?<!\\d)1[3-9]\\d{9}(?!\\d)', type: 'regex' }]);
  assert.strictEqual(bounded.test('订单号 138123456789012'), null);
  assert.ok(bounded.test('电话 13812345678 谢谢'));
});

test('非法正则被安全跳过，不影响其它规则', () => {
  const m = matcher.createMatcher([
    { pattern: '([unclosed', type: 'regex' },
    { pattern: '正常词', type: 'keyword' }
  ]);
  assert.strictEqual(m.size, 1);
  assert.ok(m.test('正常词'));
});

test('超长 pattern 被拒绝', () => {
  const long = 'a'.repeat(matcher.MAX_PATTERN_LENGTH + 1);
  assert.strictEqual(matcher.compilePattern(long, 'keyword', false), null);
  assert.ok(matcher.validatePattern(long, 'keyword', false));
});

test('validatePattern 返回可读错误', () => {
  assert.ok(matcher.validatePattern('([', 'regex', false).includes('正则表达式无效'));
  assert.strictEqual(matcher.validatePattern('1[3-9]\\d{9}', 'regex', false), null);
  assert.ok(matcher.validatePattern('   ', 'keyword', false));
});

test('重复调用编译结果被缓存复用', () => {
  const a = matcher.compilePattern('缓存测试词', 'keyword', false);
  const b = matcher.compilePattern('缓存测试词', 'keyword', false);
  assert.strictEqual(a, b);
});

section('matcher: JSON 过滤');

function makeDanmakuJson() {
  return JSON.stringify({
    status_code: 0,
    data: {
      danmaku_list: [
        { id: '1', text: '这个视频真不错' },
        { id: '2', text: '加微信 abc123 领取资料' },
        { id: '3', text: '哈哈哈哈' }
      ]
    }
  });
}

test('API 风格 JSON：命中项被移除，其余保留', () => {
  const m = matcher.createMatcher([{ id: 'rule1', pattern: '加微信', type: 'keyword' }], 'danmaku');
  const result = matcher.filterJsonText(makeDanmakuJson(), m);
  assert.ok(result, '应当产生改动');
  assert.strictEqual(result.removed, 1);
  const parsed = JSON.parse(result.text);
  assert.strictEqual(parsed.data.danmaku_list.length, 2);
  assert.ok(!result.text.includes('abc123'));
  assert.strictEqual(parsed.status_code, 0);
});

test('无命中时返回 null（调用方原样放行）', () => {
  const m = matcher.createMatcher([{ pattern: '不存在的词', type: 'keyword' }], 'danmaku');
  assert.strictEqual(matcher.filterJsonText(makeDanmakuJson(), m), null);
});

test('非 JSON 文本返回 null 不抛错', () => {
  const m = matcher.createMatcher([{ pattern: 'x', type: 'keyword' }]);
  assert.strictEqual(matcher.filterJsonText('<html>not json</html>', m), null);
});

test('命中的规则 id 会被统计', () => {
  const m = matcher.createMatcher([{ id: 'r-abc', pattern: '加微信', type: 'keyword', name: '广告' }], 'danmaku');
  const result = matcher.filterJsonText(makeDanmakuJson(), m);
  assert.ok(result.rules['r-abc']);
  assert.strictEqual(result.rules['r-abc'].count, 1);
  assert.strictEqual(result.rules['r-abc'].name, '广告');
});

test('comment_list / content 字段同样识别', () => {
  const json = JSON.stringify({ comments: [{ cid: 'c1', content: '刷单日结' }, { cid: 'c2', content: '好看' }] });
  const m = matcher.createMatcher([{ pattern: '刷单', type: 'keyword' }], 'comment');
  const result = matcher.filterJsonText(json, m);
  assert.strictEqual(result.removed, 1);
  assert.strictEqual(JSON.parse(result.text).comments.length, 1);
});

test('多层嵌套数组都能命中', () => {
  const json = JSON.stringify({
    data: { list: [{ replies: [{ text: '加微信' }, { text: '好的' }] }] }
  });
  const m = matcher.createMatcher([{ pattern: '加微信', type: 'keyword' }]);
  const result = matcher.filterJsonText(json, m);
  assert.strictEqual(result.removed, 1);
  assert.strictEqual(JSON.parse(result.text).data.list[0].replies.length, 1);
});

test('不吃掉没有文本字段的对象（如用户信息）', () => {
  const json = JSON.stringify({ data: { user: { uid: '123', nickname: '加微信的张三' } } });
  const m = matcher.createMatcher([{ pattern: '加微信', type: 'keyword' }]);
  const result = matcher.filterJsonText(json, m);
  assert.strictEqual(result, null, '昵称命中不应删除整个用户对象');
});

// ------------------------------------------------------------------ schema

section('schema: 规则标准化');

test('字符串规则转成关键词规则', () => {
  const rule = schema.normalizeRule('加微信');
  assert.strictEqual(rule.type, 'keyword');
  assert.strictEqual(rule.pattern, '加微信');
  assert.strictEqual(rule.enabled, true);
  sameShape(rule.targets, { danmaku: true, comment: true, live: true });
});

test('words 数组展开成多行关键词', () => {
  const rule = schema.normalizeRule({ words: ['加微信', '刷单'] });
  assert.strictEqual(rule.type, 'keyword');
  assert.strictEqual(rule.pattern, '加微信\n刷单');
});

test('regex 字段自动识别为正则类型', () => {
  const rule = schema.normalizeRule({ regex: '1[3-9]\\d{9}' });
  assert.strictEqual(rule.type, 'regex');
});

test('无有效内容返回 null', () => {
  assert.strictEqual(schema.normalizeRule({ name: '空规则' }), null);
  assert.strictEqual(schema.normalizeRule(null), null);
});

test('未知 action 回落到 hide', () => {
  assert.strictEqual(schema.normalizeRule({ pattern: 'x', action: 'nonsense' }).action, 'hide');
  assert.strictEqual(schema.normalizeRule({ pattern: 'x', action: 'blur' }).action, 'blur');
});

section('schema: 格式识别');

test('detectFormat 识别各格式', () => {
  assert.strictEqual(schema.detectFormat([{ pattern: 'a' }]), 'array');
  assert.strictEqual(schema.detectFormat({ rules: [] }), 'ruleset');
  assert.strictEqual(schema.detectFormat({ files: [] }), 'index');
  assert.strictEqual(schema.detectFormat({ keywords: [], regex: [] }), 'simple');
  assert.strictEqual(schema.detectFormat({ nothing: 1 }), 'unknown');
});

test('simple 简写格式导入', () => {
  const ruleSet = schema.normalizeRuleSet({
    name: '简写规则',
    keywords: ['加微信', '刷单'],
    regex: ['1[3-9]\\d{9}']
  });
  assert.strictEqual(ruleSet.rules.length, 3);
  assert.strictEqual(ruleSet.rules.filter((r) => r.type === 'regex').length, 1);
});

test('嵌套 data 包装能穿透', () => {
  const ruleSet = schema.normalizeRuleSet({ data: { rules: [{ pattern: '加微信' }] } });
  assert.strictEqual(ruleSet.rules.length, 1);
});

section('schema: 去重与合并');

test('同 pattern 同 type 视为重复', () => {
  const existing = schema.normalizeRule({ pattern: '加微信', type: 'keyword' });
  const result = schema.mergeRules([existing], [{ pattern: '加微信', type: 'keyword' }]);
  assert.strictEqual(result.added, 0);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.rules.length, 1);
});

test('同 pattern 不同类型不算重复', () => {
  const existing = schema.normalizeRule({ pattern: 'abc', type: 'keyword' });
  const result = schema.mergeRules([existing], [{ pattern: 'abc', type: 'regex' }]);
  assert.strictEqual(result.added, 1);
  assert.strictEqual(result.rules.length, 2);
});

test('skipDuplicates=false 时覆盖更新', () => {
  const existing = schema.normalizeRule({ id: 'fixed-id', pattern: '加微信', name: '旧名' });
  const result = schema.mergeRules([existing], [{ id: 'fixed-id', pattern: '加微信', name: '新名' }], {
    skipDuplicates: false
  });
  assert.strictEqual(result.updated, 1);
  assert.strictEqual(result.rules[0].name, '新名');
  assert.strictEqual(result.rules[0].id, 'fixed-id');
});

section('schema: 导出');

test('导出可被重新导入且规则数量一致', () => {
  const rules = [
    schema.normalizeRule({ pattern: '加微信\n刷单', type: 'keyword', targets: { comment: true } }),
    schema.normalizeRule({ pattern: '1[3-9]\\d{9}', type: 'regex', action: 'blur' })
  ];
  const text = schema.toRuleSet(rules, { name: '往返测试' });
  const parsed = JSON.parse(text);
  assert.strictEqual(parsed.schema, 'douyin-plus/ruleset');
  assert.strictEqual(parsed.rules.length, 2);

  const back = schema.normalizeRuleSet(parsed, { defaultSource: 'user' });
  assert.strictEqual(back.rules.length, 2);
  assert.strictEqual(back.rules[0].pattern, '加微信\n刷单');
  assert.strictEqual(back.rules[1].type, 'regex');
  assert.strictEqual(back.rules[1].action, 'blur');
  sameShape(back.rules[0].targets, { danmaku: false, comment: true, live: false });
});

// ------------------------------------------------------------------ 打包规则

section('打包的默认规则');

const bundled = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules/default-rules.json'), 'utf8'));

test('内置规则全部可解析、可编译', () => {
  const ruleSet = schema.normalizeRuleSet(bundled, { defaultSource: 'builtin' });
  assert.strictEqual(ruleSet.rules.length, bundled.rules.length, '不应有被跳过的规则');
  for (const rule of ruleSet.rules) {
    assert.strictEqual(matcher.validatePattern(rule.pattern, rule.type, rule.caseSensitive), null, rule.name);
  }
});

test('内置规则 id 唯一', () => {
  const ids = bundled.rules.map((rule) => rule.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('每条内置规则至少命中一个场景', () => {
  const ruleSet = schema.normalizeRuleSet(bundled, { defaultSource: 'builtin' });
  for (const rule of ruleSet.rules) {
    const count = Object.keys(rule.targets).filter((key) => rule.targets[key]).length;
    assert.ok(count > 0, rule.name + ' 没有生效场景，永远不会命中');
  }
});

const indexJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules/index.json'), 'utf8'));

test('远程索引里的每个文件都存在且合法', () => {
  assert.ok(Array.isArray(indexJson.files) && indexJson.files.length > 0);
  for (const file of indexJson.files) {
    const filePath = path.join(ROOT, 'rules', file.path);
    assert.ok(fs.existsSync(filePath), '缺少文件：' + file.path);
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const ruleSet = schema.normalizeRuleSet(json, { defaultSource: 'remote' });
    assert.ok(ruleSet.rules.length > 0, file.path + ' 没有规则');
    assert.strictEqual(ruleSet.rules.length, json.rules.length, file.path + ' 有规则被跳过');
    for (const rule of ruleSet.rules) {
      assert.strictEqual(matcher.validatePattern(rule.pattern, rule.type, rule.caseSensitive), null, file.path + ' / ' + rule.name);
    }
  }
});

test('远程规则集之间没有重复词条', () => {
  const seen = new Map();
  for (const file of indexJson.files) {
    const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules', file.path), 'utf8'));
    for (const rule of json.rules) {
      const key = rule.type + '\u0001' + rule.pattern;
      assert.ok(!seen.has(key), `${file.path} 的「${rule.name}」与 ${seen.get(key)} 重复`);
      seen.set(key, file.path);
    }
  }
});

section('remote: 地址解析与权限');

const remoteSandbox = { console, setTimeout, clearTimeout, URL, AbortController: globalThis.AbortController };
remoteSandbox.globalThis = remoteSandbox;
vm.createContext(remoteSandbox);
loadInto(remoteSandbox, 'src/common/matcher.js');
loadInto(remoteSandbox, 'src/common/schema.js');
loadInto(remoteSandbox, 'src/background/remote.js');
const remote = remoteSandbox.DouyinPlus.remote;

test('remote.js 可在无 chrome.* 的环境加载（设置页直接 script 引入）', () => {
  assert.ok(remote, 'remote 未挂载');
  assert.strictEqual(typeof remote.normalizeUrl, 'function');
  assert.strictEqual(typeof remote.ensureHostPermission, 'function');
});

test('GitHub blob 地址转 raw 地址', () => {
  assert.strictEqual(
    remote.normalizeUrl('https://github.com/jeanhua/douyin-plus/blob/main/rules/index.json'),
    'https://raw.githubusercontent.com/jeanhua/douyin-plus/main/rules/index.json'
  );
});

test('user/repo 简写补全为 raw 地址', () => {
  assert.strictEqual(
    remote.normalizeUrl('jeanhua/douyin-plus'),
    'https://raw.githubusercontent.com/jeanhua/douyin-plus/main/rules/index.json'
  );
  assert.strictEqual(
    remote.normalizeUrl('jeanhua/douyin-plus/rules/index.json'),
    'https://raw.githubusercontent.com/jeanhua/douyin-plus/main/rules/index.json'
  );
});

test('jsdelivr 地址保持可用', () => {
  assert.strictEqual(
    remote.normalizeUrl('https://cdn.jsdelivr.net/gh/jeanhua/douyin-plus@main/rules/index.json'),
    'https://cdn.jsdelivr.net/gh/jeanhua/douyin-plus@main/rules/index.json'
  );
});

test('空地址与无效地址返回空串', () => {
  assert.strictEqual(remote.normalizeUrl(''), '');
  assert.strictEqual(remote.normalizeUrl('   '), '');
  assert.strictEqual(remote.normalizeUrl('just-a-word'), '');
});

test('originPattern 生成 host 级权限模式', () => {
  assert.strictEqual(remote.originPattern('https://example.com/a/b.json'), 'https://example.com/*');
  assert.strictEqual(remote.originPattern('https://example.com:8443/a.json'), 'https://example.com/*');
  assert.strictEqual(remote.originPattern('ftp://example.com/a.json'), '');
  assert.strictEqual(remote.originPattern('not a url'), '');
});

test('无 chrome.permissions 时不阻塞流程', async () => {
  const allowed = await remote.ensureHostPermission('https://example.com/rules.json');
  assert.strictEqual(allowed, true);
});

test('打包默认订阅地址指向本仓库', () => {
  assert.ok(remote.normalizeUrl('https://raw.githubusercontent.com/jeanhua/douyin-plus/main/rules/index.json'));
});

section('manifest / 文件完整性');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

test('manifest 引用的文件都存在', () => {
  const refs = [];
  for (const size of Object.keys(manifest.icons)) refs.push(manifest.icons[size]);
  for (const size of Object.keys(manifest.action.default_icon)) refs.push(manifest.action.default_icon[size]);
  refs.push(manifest.action.default_popup);
  refs.push(manifest.options_ui.page);
  refs.push(manifest.background.service_worker);
  for (const cs of manifest.content_scripts) {
    (cs.js || []).forEach((f) => refs.push(f));
    (cs.css || []).forEach((f) => refs.push(f));
  }
  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(ROOT, ref)), '缺少文件：' + ref);
  }
});

test('MAIN world 内容脚本不使用 ES module 语法', () => {
  const files = [];
  for (const cs of manifest.content_scripts) {
    if (cs.world === 'MAIN') (cs.js || []).forEach((f) => files.push(f));
  }
  for (const file of files) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!/^\s*(import|export)\s/m.test(code), file + ' 含 import/export，会导致注入失败');
  }
});

test('service worker 引用的脚本都存在', () => {
  const code = fs.readFileSync(path.join(ROOT, manifest.background.service_worker), 'utf8');
  const matches = code.match(/importScripts\(([\s\S]*?)\)/);
  assert.ok(matches, '未找到 importScripts');
  const list = matches[1].match(/'([^']+)'/g) || [];
  assert.ok(list.length >= 4);
  for (const item of list) {
    const ref = item.replace(/'/g, '').replace(/^\//, '');
    assert.ok(fs.existsSync(path.join(ROOT, ref)), '缺少文件：' + ref);
  }
});

test('HTML 引用的脚本与样式都存在', () => {
  for (const page of ['src/popup/popup.html', 'src/options/options.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const refs = [];
    for (const match of html.matchAll(/<script src="([^"]+)"/g)) refs.push(match[1]);
    for (const match of html.matchAll(/<link[^>]+href="([^"]+)"/g)) refs.push(match[1]);
    for (const ref of refs) {
      const resolved = path.resolve(path.dirname(path.join(ROOT, page)), ref);
      assert.ok(fs.existsSync(resolved), `${page} 缺少 ${ref}`);
    }
  }
});

// ------------------------------------------------------------------ 结果

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
