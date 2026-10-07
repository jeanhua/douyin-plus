/**
 * douyin-plus DOM 兜底过滤（ISOLATED world）
 *
 * 网络拦截能覆盖弹幕/评论的接口响应，但仍有两类内容只能靠 DOM 清理：
 *  - 页面从本地缓存、SSR 数据、WebSocket / 长连接拿到的内容；
 *  - 接口结构变化导致拦截规则未命中时。
 *
 * 策略：MutationObserver 监听新增节点，只对"已知的内容容器"取文本匹配，
 * 命中后按规则 action 隐藏或模糊整条内容，并把命中上报后台。
 */
(function () {
  'use strict';

  const root = (globalThis.DouyinPlus = globalThis.DouyinPlus || {});
  const matcher = root.matcher;
  if (root.dom) return;
  if (!matcher) {
    // 加载顺序被破坏时显式报错：曾经因为文件被两个 world 共用而被 Chrome 去重，静默退出后极难排查
    console.warn('[douyin-plus] DOM 过滤器未启动：matcher 未先加载');
    return;
  }

  /**
   * 内容容器选择器。抖音前端类名是 CSS Modules 生成的，会变，
   * 因此以 data-* 属性为主、类名片段为辅，并且只用 closest 从新增节点向上找。
   *
   * 视频弹幕的真实结构（2026-10 实测）：播放器 > 叠加层 div.danmu >
   * 单条弹幕 div[data-danmu-id] > div.<hash>.danMuText > span，其中只有
   * data-danmu-id 与语义类名 danMuText 稳定，哈希类名（如 hOhWz449）不可依赖。
   */
  const CONTAINERS = [
    // 视频/图集评论区
    { target: 'comment', sel: '[data-e2e="comment-item"]' },
    { target: 'comment', sel: '[data-e2e*="comment-item"]' },
    { target: 'comment', sel: '[data-e2e*="commentItem"]' },
    { target: 'comment', sel: 'div[class*="commentItem"]' },
    { target: 'comment', sel: 'div[class*="CommentItem"]' },
    { target: 'comment', sel: 'li[class*="comment-"]' },
    // 视频弹幕：单条弹幕根节点带 data-danmu-id（文字在 .danMuText 内）；
    // 类名是 CSS Modules 哈希，只有语义类名 danMuText 稳定，单独作为兜底。
    { target: 'danmaku', sel: '[data-danmu-id]' },
    { target: 'danmaku', sel: '[class*="danMuText"]' },
    // 直播弹幕
    { target: 'danmaku', sel: '[data-e2e="danmaku-item"]' },
    { target: 'danmaku', sel: 'div[class*="danmaku"]' },
    { target: 'danmaku', sel: 'div[class*="Danmaku"]' },
    { target: 'danmaku', sel: 'div[class*="barrage"]' },
    // 直播聊天区（含进场、礼物文案）
    { target: 'live', sel: '[data-e2e="chat-message"]' },
    { target: 'live', sel: 'div[class*="chatroom"]' },
    { target: 'live', sel: 'div[class*="ChatMessage"]' },
    { target: 'live', sel: 'div[class*="webcast-chatroom"]' }
  ];

  /** 单条内容文本上限，超过就认为是整块容器而不是单条内容，跳过以免误伤 */
  const MAX_TEXT_LENGTH = 300;
  /** 单批新增节点的处理上限，避免长列表插入时卡帧 */
  const MAX_NODES_PER_BATCH = 400;
  /** 单批候选容器上限 */
  const MAX_CANDIDATES_PER_BATCH = 1500;

  const state = {
    matchers: {},
    settings: {},
    observer: null,
    running: false,
    /** 每个目标的规则数量，为 0 时完全跳过该目标的 DOM 扫描 */
    activeTargets: {}
  };

  const queue = new Set();
  let scheduled = false;
  let stats = { hidden: 0, byRule: new Map() };
  /** 本次批处理的扫描预算，用完就等下一批，避免长列表插入时卡帧 */
  let budget = 0;
  /**
   * 记录"这个元素已经被哪条规则处理过"。
   * 规则变更时会撤销 DOM 标记再重扫，用它保证同一条规则对同一元素只计数一次，
   * 否则每次改规则统计都会把已隐藏的内容重复算一遍。
   */
  const applied = new WeakMap();

  function textOf(el) {
    const text = el.textContent;
    if (!text) return '';
    const trimmed = text.length > MAX_TEXT_LENGTH * 2 ? '' : text.trim();
    return trimmed.length > MAX_TEXT_LENGTH ? '' : trimmed;
  }

  function targetMatcher(target) {
    if (!state.running) return null;
    const m = state.matchers[target];
    return m && m.size ? m : null;
  }

  function record(rule) {
    stats.hidden++;
    const key = rule.id || rule.pattern;
    const entry = stats.byRule.get(key) || { id: rule.id, name: rule.name, pattern: rule.pattern, count: 0 };
    entry.count++;
    stats.byRule.set(key, entry);
  }

  /** 上报到 background 做统计（bridge 内部做了节流与合并） */
  function flushStats() {
    if (!stats.hidden) return;
    const byRule = Array.from(stats.byRule.values());
    stats = { hidden: 0, byRule: new Map() };
    if (root.bridge && root.bridge.reportToBackground) {
      root.bridge.reportToBackground({
        count: byRule.reduce((sum, rule) => sum + rule.count, 0),
        origin: 'dom',
        rules: byRule,
        samples: []
      });
    }
  }

  function applyAction(el, rule) {
    if (!el || el.nodeType !== 1) return;
    const action = rule.action === 'blur' ? 'blur' : 'hide';
    const ruleId = String(rule.id || rule.pattern);

    // 标记一定补上（规则变更后需要重新隐藏），但只有"换了规则"才算一次新的命中
    el.classList.add(action === 'blur' ? 'dyp-blur' : 'dyp-hidden');
    el.setAttribute('data-dyp-rule', ruleId.slice(0, 60));
    if (el.dataset) el.dataset.dypState = 'done';

    const prev = applied.get(el);
    if (prev && prev.ruleId === ruleId && prev.action === action) return;
    applied.set(el, { ruleId: ruleId, action: action });
    record(rule);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (scheduleFlush.timer) return;
    scheduleFlush.timer = setTimeout(function () {
      scheduleFlush.timer = 0;
      flushStats();
    }, 1500);
  }

  function clearMarks() {
    const marked = document.querySelectorAll('.dyp-hidden, .dyp-blur');
    for (const el of marked) {
      el.classList.remove('dyp-hidden', 'dyp-blur');
      el.removeAttribute('data-dyp-rule');
      if (el.dataset) delete el.dataset.dypState;
    }
  }

  /** 处理一个元素：判断它自身或它的祖先是否是内容容器，并做匹配 */
  function handleElement(el) {
    if (!el || el.nodeType !== 1) return;
    if (budget-- <= 0) return;
    // 已处理过且规则没变时，跳过重复匹配（规则变更会清掉该标记）
    if (el.dataset && el.dataset.dypState === 'done') return;

    for (const item of CONTAINERS) {
      if (!state.activeTargets[item.target]) continue;
      // 先看自身，再向上找最近的容器
      let node = el.matches && el.matches(item.sel) ? el : null;
      if (!node && el.closest) node = el.closest(item.sel);
      if (!node) continue;

      const m = targetMatcher(item.target);
      if (!m) continue;
      const text = textOf(node);
      if (!text) continue;
      const hit = m.test(text);
      if (hit) {
        applyAction(node, hit);
        return;
      }
    }
  }

  /** 从一棵子树里收集候选元素 */
  function collect(root, out) {
    if (!root || root.nodeType !== 1) return out;
    const selector = CONTAINERS.filter((c) => state.activeTargets[c.target]).map((c) => c.sel).join(',');
    if (!selector) return out;
    try {
      const found = root.querySelectorAll(selector);
      for (const el of found) {
        out.push(el);
        if (out.length >= MAX_NODES_PER_BATCH) return out;
      }
    } catch (_) {}
    return out;
  }

  function processQueue() {
    scheduled = false;
    if (!queue.size) return;
    const nodes = Array.from(queue).slice(0, MAX_NODES_PER_BATCH);
    queue.clear();

    budget = MAX_CANDIDATES_PER_BATCH;
    const candidates = [];
    for (const node of nodes) {
      handleElement(node);
      collect(node, candidates);
    }
    const seen = new Set();
    for (const el of candidates) {
      if (seen.has(el)) continue;
      seen.add(el);
      handleElement(el);
    }
  }

  function schedule(node) {
    queue.add(node);
    if (scheduled) return;
    scheduled = true;
    // 用 requestIdleCallback 在空闲时处理，避免影响滚动流畅度
    const run = function () {
      processQueue();
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 500 });
    else setTimeout(run, 60);
  }

  function onMutations(mutations) {
    if (!state.running) return;
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;
      const added = mutation.addedNodes;
      for (let i = 0; i < added.length; i++) {
        const node = added[i];
        if (node && node.nodeType === 1) schedule(node);
      }
    }
  }

  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(onMutations);
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (!state.observer) return;
    state.observer.disconnect();
    state.observer = null;
  }

  /** 规则或设置变化时由 bridge 调用 */
  function onRulesChanged(rules, settings) {
    const targets = (settings && settings.targets) || {};
    state.settings = settings || {};
    state.matchers = {};
    state.activeTargets = {};
    const list = Array.isArray(rules) ? rules : [];
    for (const target of matcher.TARGETS) {
      const m = matcher.createMatcher(list, target);
      state.matchers[target] = m;
      state.activeTargets[target] = m.size > 0 && targets[target] !== false;
    }

    const enabled = !settings || settings.enabled !== false;
    const domEnabled = !settings || settings.domFilter !== false;
    const shouldRun = enabled && domEnabled;

    // 规则可能被删除或停用，先把上一次的标记撤掉再按新规则重扫，
    // 否则已经被隐藏的内容在规则删掉后依然看不见。
    clearMarks();

    if (shouldRun) {
      if (!state.running) {
        state.running = true;
        startObserver();
      }
      budget = MAX_CANDIDATES_PER_BATCH * 4;
      const candidates = [];
      collect(document.documentElement || document.body, candidates);
      for (const el of candidates) handleElement(el);
      scheduleFlush();
    } else if (state.running) {
      state.running = false;
      stopObserver();
    }
  }

  root.dom = {
    onRulesChanged: onRulesChanged,
    scan: function (node) {
      budget = MAX_CANDIDATES_PER_BATCH;
      const candidates = [];
      collect(node || document.documentElement, candidates);
      for (const el of candidates) handleElement(el);
      scheduleFlush();
      return candidates.length;
    },
    stats: function () {
      return { running: state.running, activeTargets: state.activeTargets, hidden: stats.hidden };
    }
  };

  // 暴露给控制台手动调试：DouyinPlusDom.scan(document.body)
  try {
    Object.defineProperty(window, 'DouyinPlusDom', { value: root.dom, configurable: true });
  } catch (_) {}
})();
