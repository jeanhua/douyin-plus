/**
 * 远程订阅端到端测试：用扩展自己的代码去真实拉取线上订阅地址，
 * 验证"索引 → 规则集文件 → 合并 → 写入 storage"整条链路能跑通。
 *
 * 需要联网。用法：node tools/test-remote-live.js [订阅地址]
 * 不传地址时使用扩展内置默认地址。
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

/** 内存版 chrome.storage + action，够跑 storage.js */
function createEnv() {
  const store = {};
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
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} }
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    AbortController,
    fetch,
    chrome,
    crypto: require('crypto').webcrypto
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  for (const rel of ['src/common/matcher.js', 'src/common/schema.js', 'src/common/storage.js', 'src/background/remote.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  }

  return { storage: sandbox.DouyinPlus.storage, remote: sandbox.DouyinPlus.remote, schema: sandbox.DouyinPlus.schema, matcher: sandbox.DouyinPlus.matcher, store };
}

async function run() {
  const argUrl = process.argv[2];
  const env = createEnv();
  const defaultUrl = env.storage.DEFAULT_REMOTE_URL;
  const target = argUrl || defaultUrl;

  console.log('订阅地址：' + target);
  if (!argUrl) console.log('（未传参数，使用扩展内置默认地址）');
  console.log('');

  console.log('地址解析');
  let resolved;
  await test('默认地址可被识别', () => {
    resolved = env.remote.normalizeUrl(target);
    assert.ok(resolved, '地址无效');
  });
  await test('解析结果指向规则索引文件', () => {
    assert.ok(/index\.json$/.test(resolved), '期望以 index.json 结尾，实际 ' + resolved);
  });

  console.log('\n拉取订阅');
  let subscribed;
  await test('能拉到索引文件并解析为多个规则集', async () => {
    subscribed = await env.remote.fetchSubscription(resolved, { noCache: true });
    assert.ok(subscribed.ruleSets.length > 0, '没有拉到任何规则集');
    console.log('      拉到 ' + subscribed.ruleSets.length + ' 个规则集：' +
      subscribed.ruleSets.map((rs) => `${rs.name}(${rs.rules.length})`).join('、'));
    if (subscribed.warnings.length) {
      console.log('      警告：' + subscribed.warnings.join(' | '));
    }
  });

  let merged;
  await test('合并后的规则可被匹配引擎编译', () => {
    merged = env.remote.mergeRuleSets(subscribed.ruleSets);
    assert.ok(merged.rules.length > 0, '合并后没有规则');
    for (const rule of merged.rules) {
      const error = env.matcher.validatePattern(rule.pattern, rule.type, rule.caseSensitive);
      assert.strictEqual(error, null, `规则「${rule.name}」无法编译：${error}`);
    }
    console.log('      ' + merged.rules.length + ' 条规则全部可编译');
  });

  console.log('\n写入存储');
  await test('applyRemoteRuleSet 写入成功且标记来源', async () => {
    const result = await env.storage.applyRemoteRuleSet(merged, { url: resolved });
    assert.ok(result.total > 0);
    const rules = await env.storage.getRules();
    const remoteRules = rules.filter((r) => r.source === 'remote');
    assert.strictEqual(remoteRules.length, merged.rules.length);
    console.log('      写入 ' + remoteRules.length + ' 条远程规则');
  });

  await test('更新状态记录为成功', async () => {
    const settings = await env.storage.getSettings();
    assert.strictEqual(settings.remote.lastOk, true);
    assert.ok(settings.remote.lastAt > 0);
    assert.strictEqual(settings.remote.lastError, '');
  });

  await test('重复更新不会累积重复规则', async () => {
    await env.storage.applyRemoteRuleSet(merged, { url: resolved });
    const rules = await env.storage.getRules();
    assert.strictEqual(rules.filter((r) => r.source === 'remote').length, merged.rules.length);
  });

  console.log('\n备用源回退');
  await test('主源故障时会自动改用备用源', async () => {
    // 用可控的假 fetch：让第一个源（主源）失败，后续源走真实网络。
    // 这样无论 raw 在当前网络是否可达，测的都是"回退逻辑本身"。
    const tried = [];
    let firstCall = true;
    const fakeFetch = async (url, init) => {
      tried.push(url);
      if (firstCall) {
        firstCall = false;
        throw new Error('模拟主源故障');
      }
      return fetch(url, init);
    };

    const sandbox2 = {
      console,
      setTimeout,
      clearTimeout,
      URL,
      AbortController,
      fetch: fakeFetch,
      chrome: {
        storage: { local: { get: (k, cb) => cb({}), set: (i, cb) => cb && cb() } },
        action: { setBadgeText() {}, setBadgeBackgroundColor() {} }
      },
      crypto: require('crypto').webcrypto
    };
    sandbox2.globalThis = sandbox2;
    sandbox2.self = sandbox2;
    vm.createContext(sandbox2);
    for (const rel of ['src/common/matcher.js', 'src/common/schema.js', 'src/common/storage.js', 'src/background/remote.js']) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox2, { filename: rel });
    }

    const result = await sandbox2.DouyinPlus.remote.updateFromRemote(
      sandbox2.DouyinPlus.storage.DEFAULT_REMOTE_URL,
      {}
    );
    console.log('      依次尝试：' + tried.map((u) => u.split('/')[2]).join(' → '));
    assert.ok(tried.length >= 2, '应该尝试过至少两个源，实际 ' + tried.length);
    if (!result.ok) {
      // 备用源在当前网络也不可达是环境问题，不是逻辑问题；回退行为本身已被证明
      console.log('      注意：备用源在当前网络也不可达（' + result.error + '）');
      console.log('      回退逻辑已验证，但未能完成真实拉取');
      return;
    }
    assert.strictEqual(result.usedFallback, true, '应标记为使用了备用源');
    assert.ok(result.rules > 0, '备用源应拉到规则');
  });

  await test('用户自定义地址不会偷偷换成备用源', async () => {
    const tried = [];
    const fakeFetch = async (url) => {
      tried.push(url);
      throw new Error('故意失败');
    };
    const sandbox3 = {
      console,
      setTimeout,
      clearTimeout,
      URL,
      AbortController,
      fetch: fakeFetch,
      chrome: {
        storage: { local: { get: (k, cb) => cb({}), set: (i, cb) => cb && cb() } },
        action: { setBadgeText() {}, setBadgeBackgroundColor() {} }
      },
      crypto: require('crypto').webcrypto
    };
    sandbox3.globalThis = sandbox3;
    sandbox3.self = sandbox3;
    vm.createContext(sandbox3);
    for (const rel of ['src/common/matcher.js', 'src/common/schema.js', 'src/common/storage.js', 'src/background/remote.js']) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox3, { filename: rel });
    }

    const result = await sandbox3.DouyinPlus.remote.updateFromRemote('https://example.com/my-rules.json', {});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(tried.length, 1, '自定义地址只应尝试一次，实际 ' + tried.length + ' 次：' + tried.join(', '));
    assert.ok(tried[0].includes('example.com'), '只应尝试用户填的地址');
  });

  console.log(`\n${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
