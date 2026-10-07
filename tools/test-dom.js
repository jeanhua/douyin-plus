/**
 * DOM 过滤层的集成自测：用一个最小 DOM 实现（够用即可）跑 dom-filter.js / bridge.js，
 * 验证"命中→隐藏/模糊、规则删除→恢复、批量顺序、统计上报"等真实行为。
 *
 * 用法：node tools/test-dom.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

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

// ---------------------------------------------------------------- 最小 DOM

/** 支持 dom-filter 用到的选择器：tag、.class、[attr]、[attr="v"]、[attr*="v"]、逗号分组 */
function parseSelector(selector) {
  return selector.split(',').map((part) => {
    const text = part.trim();
    const m = text.match(
      /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)(\[([\w-]+)(?:([*^$]?)=["']?([^"'\]]*)["']?)?\])?$/
    );
    if (!m) throw new Error('mock DOM 不支持的 selector：' + text);
    return {
      tag: m[1] ? m[1].toUpperCase() : null,
      classes: m[2] ? m[2].split('.').filter(Boolean) : [],
      attr: m[4] || null,
      op: m[5] || null,
      value: m[6]
    };
  });
}

function matchesSimple(el, simple) {
  if (simple.tag && el.tagName !== simple.tag) return false;
  for (const name of simple.classes) {
    if (!el.classList.contains(name)) return false;
  }
  if (simple.attr) {
    // class 走 className（真实 DOM 里 [class*=...] 只看 class 属性，不看 classList 之外的来源）
    const raw =
      simple.attr === 'class'
        ? el.className
        : simple.attr.startsWith('data-')
        ? el.dataset[simple.attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())]
        : el.attributes[simple.attr];
    if (raw === undefined || raw === null || raw === '') return false;
    const value = String(raw);
    if (simple.op === '*' && value.indexOf(simple.value) === -1) return false;
    if (simple.op === '^' && value.indexOf(simple.value) !== 0) return false;
    if (simple.op === '=' && value !== simple.value) return false;
  }
  return true;
}

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(...names) {
    names.forEach((n) => this.set.add(n));
  }
  remove(...names) {
    names.forEach((n) => this.set.delete(n));
  }
  contains(name) {
    return this.set.has(name);
  }
  toString() {
    return Array.from(this.set).join(' ');
  }
}

class Element {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = document;
    this.childNodes = [];
    this.parentNode = null;
    this.classList = new ClassList();
    this.dataset = {};
    this.attributes = {};
    this._text = '';
  }
  get className() {
    return this.classList.toString();
  }
  set className(value) {
    this.classList = new ClassList();
    String(value)
      .split(/\s+/)
      .filter(Boolean)
      .forEach((n) => this.classList.add(n));
  }
  get textContent() {
    if (this._text) return this._text;
    return this.childNodes.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    this._text = String(value);
    this.childNodes = [];
  }
  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const list = this.parentNode.childNodes;
    const at = list.indexOf(this);
    if (at >= 0) list.splice(at, 1);
    this.parentNode = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
    if (name === 'class') this.className = value;
  }
  getAttribute(name) {
    if (name === 'class') return this.className;
    return this.attributes[name] === undefined ? null : this.attributes[name];
  }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      delete this.dataset[key];
    }
  }
  matches(selector) {
    return parseSelector(selector).some((simple) => matchesSimple(this, simple));
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.nodeType === 1 && node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelectorAll(selector) {
    const simples = parseSelector(selector);
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (simples.some((simple) => matchesSimple(child, simple))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class Document {
  constructor() {
    this.documentElement = new Element('html', this);
    this.body = new Element('body', this);
    this.documentElement.appendChild(this.body);
    this.visibilityState = 'visible';
    this.listeners = {};
  }
  createElement(tag) {
    return new Element(tag, this);
  }
  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
}

// ---------------------------------------------------------------- 环境装配

function createEnv(storedState) {
  const document = new Document();
  const messages = [];
  const posted = [];

  const chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          for (const key of [].concat(keys)) {
            if (storedState[key] !== undefined) out[key] = storedState[key];
          }
          cb(out);
        },
        set(items, cb) {
          Object.assign(storedState, items);
          if (cb) cb();
        }
      },
      onChanged: { addListener() {} }
    },
    runtime: {
      lastError: null,
      sendMessage(message, cb) {
        messages.push(message);
        if (cb) cb({ ok: true });
      },
      onMessage: { addListener() {} }
    }
  };

  let idleCallbacks = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    chrome,
    document,
    location: { hostname: 'www.douyin.com', href: 'https://www.douyin.com/video/1', origin: 'https://www.douyin.com' },
    crypto: require('crypto').webcrypto,
    requestIdleCallback(fn) {
      idleCallbacks.push(fn);
    },
    MutationObserver: class {
      constructor(cb) {
        this.cb = cb;
      }
      observe() {
        this.observing = true;
      }
      disconnect() {
        this.observing = false;
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.postMessage = (payload) => posted.push(payload);
  vm.createContext(sandbox);

  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  load('src/common/matcher.js');
  load('src/common/schema.js');
  load('src/common/storage.js');
  load('src/content/dom-filter.js');
  load('src/content/bridge.js');

  return {
    sandbox,
    document,
    messages,
    posted,
    flushIdle() {
      const pending = idleCallbacks;
      idleCallbacks = [];
      pending.forEach((fn) => fn());
    },
    /** bridge 里的上报是 1s 节流，测试里手动跑定时器 */
    async wait(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  };
}

function makeComment(text) {
  const el = new Element('div', null);
  el.className = 'commentItem';
  el.setAttribute('data-e2e', 'comment-item');
  el._text = text;
  return el;
}

function rule(overrides) {
  return Object.assign(
    {
      id: 'r1',
      name: '测试规则',
      pattern: '加微信',
      type: 'keyword',
      caseSensitive: false,
      targets: { danmaku: true, comment: true, live: true },
      action: 'hide',
      enabled: true,
      source: 'user'
    },
    overrides
  );
}

async function run() {
  section('dom-filter: 基本屏蔽');

  {
    const stored = { rules: [rule({})], settings: { enabled: true, targets: { danmaku: true, comment: true, live: true }, domFilter: true } };
    const env = createEnv(stored);
    const dom = env.sandbox.DouyinPlus.dom;

    const good = env.document.createElement('div');
    const bad = makeComment('快来加微信领取资料');
    env.document.body.appendChild(good);
    env.document.body.appendChild(bad);
    env.document.body.appendChild(makeComment('这个视频不错'));

    dom.onRulesChanged(stored.rules, stored.settings);
    env.flushIdle();

    test('命中内容被隐藏', () => {
      assert.ok(bad.classList.contains('dyp-hidden'), '命中项应添加 dyp-hidden');
      assert.strictEqual(bad.style, undefined);
    });
    test('未命中内容不受影响', () => {
      const others = env.document.body.childNodes.filter((el) => el !== bad);
      for (const el of others) assert.ok(!el.classList.contains('dyp-hidden'));
    });
    test('标记了来源规则', () => {
      assert.strictEqual(bad.getAttribute('data-dyp-rule'), 'r1');
    });
  }

  section('dom-filter: blur 动作与规则变更');

  {
    const blurRule = rule({ id: 'rb', action: 'blur' });
    const stored = { rules: [blurRule], settings: { enabled: true, targets: { danmaku: true, comment: true, live: true }, domFilter: true } };
    const env = createEnv(stored);
    const dom = env.sandbox.DouyinPlus.dom;

    const el = makeComment('加微信');
    env.document.body.appendChild(el);
    dom.onRulesChanged(stored.rules, stored.settings);
    env.flushIdle();

    test('blur 规则添加 dyp-blur 而非隐藏', () => {
      assert.ok(el.classList.contains('dyp-blur'), '应该模糊');
      assert.ok(!el.classList.contains('dyp-hidden'), '不应该隐藏');
    });

    test('删除规则后已模糊内容恢复', () => {
      dom.onRulesChanged([], { enabled: true, targets: { danmaku: true, comment: true, live: true }, domFilter: true });
      env.flushIdle();
      assert.ok(!el.classList.contains('dyp-blur'), '规则删除后应撤销标记');
      assert.strictEqual(el.getAttribute('data-dyp-rule'), null);
    });
  }

  section('dom-filter: 视频弹幕');

  {
    // 还原抖音真实结构：叠加层 > 单条弹幕（data-danmu-id）> div.danMuText > 文本
    const blurRule = rule({ id: 'rd', action: 'blur', targets: { danmaku: true } });
    const stored = {
      rules: [blurRule],
      settings: { enabled: true, targets: { danmaku: true, comment: true, live: true }, domFilter: true }
    };
    const env = createEnv(stored);
    const dom = env.sandbox.DouyinPlus.dom;

    const overlay = env.document.createElement('div');
    overlay.className = 'x6QYrwaa ntlxAYR5 danmu';
    env.document.body.appendChild(overlay);

    const makeDanmaku = (id, textValue) => {
      const item = env.document.createElement('div');
      item.className = 'hOhWz449 FJn8osCU';
      item.setAttribute('data-danmu-id', id);
      const text = env.document.createElement('div');
      text.className = 'pCpu7utj danMuText';
      text.textContent = textValue;
      item.appendChild(text);
      overlay.appendChild(item);
      return { item, text };
    };

    const hit = makeDanmaku('7663726254868906792', '快来加微信领取资料');
    const miss = makeDanmaku('7663726254868906793', '这个视频真不错');
    dom.onRulesChanged(stored.rules, stored.settings);
    env.flushIdle();

    test('命中弹幕整条被模糊（含哈希类名的真实结构）', () => {
      assert.ok(hit.item.classList.contains('dyp-blur'), '弹幕条目应加 dyp-blur');
      assert.ok(!hit.text.classList.contains('dyp-blur'), '不应重复模糊内部文本节点');
      assert.strictEqual(hit.item.getAttribute('data-dyp-rule'), 'rd');
    });
    test('未命中弹幕不受影响', () => {
      assert.ok(!miss.item.classList.contains('dyp-blur'));
      assert.ok(!miss.item.classList.contains('dyp-hidden'));
    });

    // 新插入的弹幕（MutationObserver 路径）也应被处理
    const later = makeDanmaku('7663726254868906794', '加微信看后续');
    dom.scan(overlay);
    env.flushIdle();
    test('动态插入的弹幕同样被模糊', () => {
      assert.ok(later.item.classList.contains('dyp-blur'));
    });
  }

  section('dom-filter: 开关');

  {
    const stored = { rules: [rule({})], settings: { enabled: false, targets: { danmaku: true, comment: true, live: true }, domFilter: true } };
    const env = createEnv(stored);
    const dom = env.sandbox.DouyinPlus.dom;
    const el = makeComment('加微信');
    env.document.body.appendChild(el);
    dom.onRulesChanged(stored.rules, stored.settings);
    env.flushIdle();

    test('总开关关闭时不隐藏', () => {
      assert.ok(!el.classList.contains('dyp-hidden'));
      assert.strictEqual(dom.stats().running, false);
    });

    test('开启后立即可用（无需刷新页面）', () => {
      dom.onRulesChanged(stored.rules, { enabled: true, targets: { danmaku: true, comment: true, live: true }, domFilter: true });
      env.flushIdle();
      assert.ok(el.classList.contains('dyp-hidden'), '开启后应立刻生效');
    });
  }

  section('dom-filter: 场景过滤');

  {
    // 存储里的规则都经过 schema.normalizeTargets 归一化：未勾选的场景显式写成 false。
    // 这里必须用归一化后的形状，否则 matcher 的宽松语义（缺失键视为启用）会让弹幕也命中。
    const stored = {
      rules: [rule({ targets: { danmaku: false, comment: true, live: false } })],
      settings: { enabled: true, targets: { danmaku: true, comment: true, live: true }, domFilter: true }
    };
    const env = createEnv(stored);
    const dom = env.sandbox.DouyinPlus.dom;

    const danmakuEl = env.document.createElement('div');
    danmakuEl.className = 'danmaku-item';
    danmakuEl._text = '加微信';
    const commentEl = makeComment('加微信');
    env.document.body.appendChild(danmakuEl);
    env.document.body.appendChild(commentEl);

    dom.onRulesChanged(stored.rules, stored.settings);
    env.flushIdle();

    test('只作用于评论时弹幕不受影响', () => {
      assert.ok(!danmakuEl.classList.contains('dyp-hidden'), '弹幕不该被隐藏');
      assert.ok(commentEl.classList.contains('dyp-hidden'), '评论应该被隐藏');
    });
  }

  section('dom-filter: 边界情况');

  {
    const stored = { rules: [rule({})], settings: { enabled: true, targets: { danmaku: true, comment: true, live: true }, domFilter: true } };
    const env = createEnv(stored);
    const dom = env.sandbox.DouyinPlus.dom;

    const huge = makeComment('x'.repeat(500) + '加微信');
    env.document.body.appendChild(huge);
    dom.onRulesChanged(stored.rules, stored.settings);
    env.flushIdle();

    test('超长文本（疑似整块容器）不参与匹配', () => {
      assert.ok(!huge.classList.contains('dyp-hidden'), '超长文本应跳过，避免误伤整块区域');
    });
  }

  {
    const stored = { rules: [rule({ pattern: '([bad', type: 'regex' })], settings: { enabled: true, targets: { danmaku: true, comment: true, live: true }, domFilter: true } };
    const env = createEnv(stored);
    const dom = env.sandbox.DouyinPlus.dom;
    const el = makeComment('任何内容');
    env.document.body.appendChild(el);

    test('非法正则不阻断过滤流程', () => {
      dom.onRulesChanged(stored.rules, stored.settings);
      env.flushIdle();
      assert.strictEqual(dom.stats().activeTargets.comment, false, '无有效规则时应停用该场景扫描');
    });
  }

  {
    const stored = { rules: [], settings: { enabled: true, targets: { danmaku: true, comment: true, live: true }, domFilter: false } };
    const env = createEnv(stored);
    const dom = env.sandbox.DouyinPlus.dom;
    dom.onRulesChanged(stored.rules, stored.settings);

    test('DOM 兜底开关关闭时不运行', () => {
      assert.strictEqual(dom.stats().running, false);
    });
  }

  section('dom-filter: 统计上报');

  {
    const stored = { rules: [rule({})], settings: { enabled: true, targets: { danmaku: true, comment: true, live: true }, domFilter: true } };
    const env = createEnv(stored);
    const dom = env.sandbox.DouyinPlus.dom;
    for (let i = 0; i < 3; i++) env.document.body.appendChild(makeComment('加微信'));
    dom.onRulesChanged(stored.rules, stored.settings);
    env.flushIdle();

    // 命中上报经过两层节流：dom-filter 1.5s 汇总 + bridge 1s 合并，等它们都跑完
    await env.wait(3000);

    test('上报数量与规则命中统计', () => {
      const payloads = env.messages.filter((m) => m.type === 'dyp:blocks');
      const total = payloads.reduce((sum, p) => sum + p.count, 0);
      assert.strictEqual(total, 3, '应上报 3 次命中，实际 ' + total);
      const first = payloads[0];
      assert.strictEqual(first.origin, 'dom');
      assert.ok(first.rules.some((r) => r.id === 'r1'));
    });
  }

  section('bridge: 容量上限');

  {
    const stored = { rules: [rule({})], settings: { enabled: true, targets: { danmaku: true, comment: true, live: true }, domFilter: true } };
    const env = createEnv(stored);
    const dom = env.sandbox.DouyinPlus.dom;
    for (let i = 0; i < 200; i++) env.document.body.appendChild(makeComment('加微信'));
    dom.onRulesChanged(stored.rules, stored.settings);
    env.flushIdle();

    test('大量命中项一次处理不完时不会漏掉（预算按批重置）', () => {
      const hidden = env.document.body.childNodes.filter((el) => el.classList.contains('dyp-hidden')).length;
      assert.ok(hidden > 0, '至少应处理一部分');
      // 再触发一轮扫描，剩余项应被补齐
      dom.scan(env.document.body);
      env.flushIdle();
      const after = env.document.body.childNodes.filter((el) => el.classList.contains('dyp-hidden')).length;
      assert.ok(after >= hidden, '第二轮不应减少');
      assert.ok(after > 100, '多轮扫描后应处理大部分内容，实际 ' + after);
    });
  }

  console.log(`\n${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
