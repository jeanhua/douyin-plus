/**
 * 存储层自测：内置规则同步、远程规则替换、统计、规则修订号。
 * 用一个内存版 chrome.storage 模拟扩展环境。
 *
 * 用法：node tools/test-storage.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('    ' + (err && err.message ? err.message : String(err)));
  }
}
const section = (t) => console.log('\n' + t);

// 每个用例一个独立环境，避免互相污染
function createEnv(initial) {
  const store = Object.assign({}, initial || {});
  const badges = [];
  const chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          for (const key of [].concat(keys)) if (store[key] !== undefined) out[key] = store[key];
          cb(out);
        },
        set(items, cb) {
          Object.assign(store, JSON.parse(JSON.stringify(items)));
          if (cb) cb();
        }
      }
    },
    action: {
      setBadgeText(args) {
        badges.push(args.text);
      },
      setBadgeBackgroundColor() {}
    }
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    chrome,
    crypto: require('crypto').webcrypto,
    Date
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  for (const rel of ['src/common/matcher.js', 'src/common/schema.js', 'src/common/storage.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  }

  return { storage: sandbox.DouyinPlus.storage, schema: sandbox.DouyinPlus.schema, store, badges };
}

async function run() {
  const bundled = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules/default-rules.json'), 'utf8'));

  section('内置规则装载');

  {
    const env = createEnv();
    const ruleSet = env.schema.normalizeRuleSet(bundled, { defaultSource: 'builtin' });
    await env.storage.applyBuiltinRuleSet(ruleSet, { force: true });

    const rules = await env.storage.getRules();
    await test('首次装载写入全部内置规则', async () => {
      assert.strictEqual(rules.length, bundled.rules.length);
      assert.ok(rules.every((r) => r.source === 'builtin'));
    });

    await test('记录内置规则版本', async () => {
      const settings = await env.storage.getSettings();
      assert.strictEqual(settings.builtinVersion, bundled.version);
    });

    await test('版本未变时不重复同步', async () => {
      const result = await env.storage.applyBuiltinRuleSet(ruleSet, { force: false });
      assert.strictEqual(result.changed, false);
    });

    await test('保存规则会自增修订号（内容脚本据此下发）', async () => {
      const before = (await env.storage.getSettings()).rulesRev;
      await env.storage.saveRules(rules);
      const after = (await env.storage.getSettings()).rulesRev;
      assert.strictEqual(after, before + 1);
    });

    await test('用户停用某条内置规则后，重新同步仍保持停用', async () => {
      const target = rules[1].id;
      await env.storage.saveRules(rules.map((r) => (r.id === target ? Object.assign({}, r, { enabled: false }) : r)));
      await env.storage.applyBuiltinRuleSet(ruleSet, { force: true });
      const after = await env.storage.getRules();
      const rule = after.find((r) => r.id === target);
      assert.strictEqual(rule.enabled, false, '用户的停用状态应被保留');
    });

    await test('用户删除的内置规则不会被同步回来', async () => {
      const removedId = rules[2].id;
      const rest = (await env.storage.getRules()).filter((r) => r.id !== removedId);
      await env.storage.saveRules(rest);
      await env.storage.addHiddenIds([removedId]);

      await env.storage.applyBuiltinRuleSet(ruleSet, { force: true });
      const after = await env.storage.getRules();
      assert.ok(!after.some((r) => r.id === removedId), '被删除的内置规则不该复活');
    });

    await test('内置规则排在自建规则之前', async () => {
      const custom = env.schema.normalizeRule({ pattern: '我的规则', type: 'keyword' }, { defaultSource: 'user' });
      const current = await env.storage.getRules();
      await env.storage.saveRules(current.concat([custom]));
      await env.storage.applyBuiltinRuleSet(ruleSet, { force: true });
      const after = await env.storage.getRules();
      const firstUserAt = after.findIndex((r) => r.source === 'user');
      const lastBuiltinAt = after.map((r) => r.source).lastIndexOf('builtin');
      assert.ok(lastBuiltinAt < firstUserAt, '内置规则应排在前面');
    });
  }

  section('远程规则替换');

  {
    const env = createEnv();
    const makeRemoteSet = (version) => ({
      name: '远程测试集',
      version: version,
      rulesetVersion: version,
      rules: env.schema
        .normalizeRuleSet(
          {
            rules: [
              { name: '远程规则 A', pattern: '远程词A', type: 'keyword', targets: 'all' },
              { name: '远程规则 B', pattern: '远程词B', type: 'keyword', targets: 'all' }
            ]
          },
          { defaultSource: 'remote' }
        )
        .rules.map((r) => Object.assign({}, r, { source: 'remote' }))
    });

    await env.storage.applyRemoteRuleSet(makeRemoteSet(1));
    const first = await env.storage.getRules();

    await test('远程规则写入且标记来源', async () => {
      assert.ok(first.length >= 2);
      assert.ok(first.every((r) => r.source === 'remote'));
    });

    await test('记录远程更新状态', async () => {
      const settings = await env.storage.getSettings();
      assert.strictEqual(settings.remote.lastOk, true);
      assert.strictEqual(settings.remote.lastCount, 2);
      assert.ok(settings.remote.lastAt > 0);
    });

    await test('用户停用某条远程规则后，更新时按内容保留停用状态', async () => {
      // 模拟：用户停用了"远程规则 B"
      const withDisabled = (await env.storage.getRules()).map((r) =>
        r.pattern === '远程词B' ? Object.assign({}, r, { enabled: false }) : r
      );
      await env.storage.saveRules(withDisabled);

      // 再拉一次（id 会因重新生成而不同，这正是要覆盖的场景）
      await env.storage.applyRemoteRuleSet(makeRemoteSet(2));
      const after = await env.storage.getRules();
      const ruleB = after.find((r) => r.pattern === '远程词B');
      assert.ok(ruleB, '规则 B 应该还在');
      assert.strictEqual(ruleB.enabled, false, '停用状态必须按内容保留，而不是随 id 丢失');
    });

    await test('远程更新不会动自建规则', async () => {
      const custom = env.schema.normalizeRule({ pattern: '我的自建词', type: 'keyword' }, { defaultSource: 'user' });
      const current = await env.storage.getRules();
      await env.storage.saveRules(current.concat([custom]));

      await env.storage.applyRemoteRuleSet(makeRemoteSet(3));
      const after = await env.storage.getRules();
      assert.ok(after.some((r) => r.pattern === '我的自建词'), '自建规则不能被远程更新覆盖');
    });

    await test('远程更新是整体替换，不会累积重复', async () => {
      await env.storage.applyRemoteRuleSet(makeRemoteSet(4));
      const after = await env.storage.getRules();
      const remoteRules = after.filter((r) => r.source === 'remote');
      assert.strictEqual(remoteRules.length, 2, '重复更新后远程规则应仍为 2 条，实际 ' + remoteRules.length);
    });
  }

  section('订阅失败记录');

  {
    const env = createEnv();
    await env.storage.setRemoteError('网络不可达');
    await test('失败原因写入设置', async () => {
      const settings = await env.storage.getSettings();
      assert.strictEqual(settings.remote.lastOk, false);
      assert.strictEqual(settings.remote.lastError, '网络不可达');
    });
  }

  section('统计');

  {
    const env = createEnv();
    const stats = await env.storage.recordBlocks({
      count: 5,
      origin: 'network',
      rules: [
        { id: 'r1', name: 'A', pattern: 'a', count: 3 },
        { id: 'r2', name: 'B', pattern: 'b', count: 2 }
      ]
    });

    await test('累计与按日计数', async () => {
      assert.strictEqual(stats.total, 5);
      const today = env.storage.todayKey();
      assert.strictEqual(stats.byDate[today], 5);
    });

    await test('按规则计数', async () => {
      assert.strictEqual(stats.byRule.r1, 3);
      assert.strictEqual(stats.byRule.r2, 2);
    });

    await test('角标显示今日数量', async () => {
      assert.ok(env.badges.includes('5'), '角标应显示 5，实际 ' + JSON.stringify(env.badges));
    });

    await test('清空统计后归零', async () => {
      await env.storage.resetStats();
      const after = await env.storage.getStats();
      assert.strictEqual(after.total, 0);
      assert.deepStrictEqual(after.byRule, {});
    });

    await test('count 为 0 时不写入', async () => {
      const before = await env.storage.getStats();
      await env.storage.recordBlocks({ count: 0, rules: [] });
      const after = await env.storage.getStats();
      assert.strictEqual(after.total, before.total);
    });
  }

  section('设置');

  {
    const env = createEnv();
    await test('默认设置可读且包含远程配置', async () => {
      const settings = await env.storage.getSettings();
      assert.strictEqual(settings.enabled, true);
      assert.strictEqual(settings.domFilter, true);
      assert.ok(settings.remote.url.indexOf('douyin-plus') !== -1);
      assert.strictEqual(settings.remote.enabled, false);
    });

    await test('深层合并不会丢掉未修改的字段', async () => {
      await env.storage.saveSettings({ remote: { intervalHours: 6 } });
      const settings = await env.storage.getSettings();
      assert.strictEqual(settings.remote.intervalHours, 6);
      assert.ok(settings.remote.url, '未修改的 url 不应被清空');
      assert.strictEqual(settings.enabled, true, '未修改的顶层字段不应被清空');
    });

    await test('生效规则过滤掉停用项', async () => {
      const schema = env.schema;
      await env.storage.saveRules([
        schema.normalizeRule({ pattern: '启用', type: 'keyword', enabled: true }, { defaultSource: 'user' }),
        schema.normalizeRule({ pattern: '停用', type: 'keyword', enabled: false }, { defaultSource: 'user' })
      ]);
      const effective = await env.storage.getEffectiveRules();
      assert.strictEqual(effective.length, 1);
      assert.strictEqual(effective[0].pattern, '启用');
    });
  }

  console.log(`\n${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
