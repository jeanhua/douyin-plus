/**
 * douyin-plus 规则下发桥接（ISOLATED world）
 *
 * 职责：
 *  1. 从 chrome.storage 读取规则与设置，通过 window.postMessage 下发给 MAIN world 的网络拦截器；
 *  2. 监听 storage 变化（面板改了规则立即生效，无需刷新页面）；
 *  3. 把 MAIN world 与 DOM 层的屏蔽结果上报给 background 做统计。
 */
(function () {
  'use strict';

  const root = (globalThis.DouyinPlus = globalThis.DouyinPlus || {});
  if (root.bridge) return;

  const CHANNEL_IN = 'douyin-plus';
  const CHANNEL_OUT = 'douyin-plus-main';
  const storage = root.storage;

  function post(payload) {
    const message = Object.assign({ source: CHANNEL_IN }, payload);
    try {
      window.postMessage(message, window.location.origin);
    } catch (_) {
      try {
        window.postMessage(message, '*');
      } catch (__) {}
    }
  }

  /** 只有顶层窗口和抖音自己的 iframe 需要下发，第三方 iframe 直接跳过 */
  function shouldRun() {
    const host = location.hostname;
    return /(^|\.)douyin\.com$/.test(host);
  }

  let lastSignature = '';

  async function pushRules(force) {
    if (!shouldRun()) return;
    const state = await storage.getState();
    // 规则修订号 + 总开关 + 场景开关，够用且几乎零成本
    const signature = [
      state.settings.rulesRev || 0,
      state.settings.enabled !== false ? 1 : 0,
      state.settings.targets ? state.settings.targets.danmaku !== false ? 1 : 0 : 1,
      state.settings.targets ? state.settings.targets.comment !== false ? 1 : 0 : 1,
      state.settings.targets ? state.settings.targets.live !== false ? 1 : 0 : 1
    ].join('|');
    if (!force && signature === lastSignature) return;
    lastSignature = signature;

    const effective = state.rules.filter((rule) => rule && rule.enabled !== false);
    post({ type: 'rules', rules: effective, settings: { enabled: state.settings.enabled, targets: state.settings.targets } });
    if (root.dom) root.dom.onRulesChanged(effective, state.settings);
  }

  root.bridge = {
    pushRules: pushRules,
    post: post,
    ready: true
  };

  // 来自 MAIN world 的屏蔽上报
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL_OUT) return;
    if (data.type === 'blocked') {
      reportToBackground({
        count: data.count,
        origin: data.origin || 'network',
        rules: data.rules || [],
        samples: data.samples || []
      });
    }
  });

  let reportQueue = [];
  let reportTimer = 0;

  /** DOM 层命中也通过这里上报 */
  function reportToBackground(payload) {
    if (!payload || !payload.count) return;
    reportQueue.push(payload);
    if (reportTimer) return;
    reportTimer = setTimeout(flushReports, 1000);
  }

  function flushReports() {
    reportTimer = 0;
    const queue = reportQueue;
    reportQueue = [];
    if (!queue.length) return;
    const merged = {
      count: 0,
      origin: queue[0].origin,
      rules: [],
      samples: []
    };
    const byRule = new Map();
    for (const item of queue) {
      merged.count += item.count;
      for (const rule of item.rules) {
        const key = rule && rule.id;
        if (!key) continue;
        const entry = byRule.get(key) || { id: key, name: rule.name, pattern: rule.pattern, count: 0 };
        entry.count += rule.count || 1;
        byRule.set(key, entry);
      }
      for (const sample of item.samples || []) {
        if (merged.samples.length < 5) merged.samples.push(sample);
      }
    }
    merged.rules = Array.from(byRule.values());
    try {
      chrome.runtime.sendMessage(Object.assign({ type: 'dyp:blocks' }, merged), function () {
        // 扩展更新/卸载时 lastError 会置位，忽略即可
        void chrome.runtime.lastError;
      });
    } catch (_) {
      /* 上下文失效（扩展重载）时静默 */
    }
  }

  root.bridge.reportToBackground = reportToBackground;

  // storage 变化 → 重新下发
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.rules || changes.settings || changes.hiddenIds) pushRules(true);
  });

  // 来自 popup / options 的即时指令
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || typeof message !== 'object') return false;
    if (message.type === 'dyp:refresh') {
      pushRules(true).then(function () {
        sendResponse({ ok: true });
      });
      return true;
    }
    if (message.type === 'dyp:ping') {
      sendResponse({ ok: true, href: location.href, frame: window.top === window });
      return false;
    }
    return false;
  });

  // 页面可能在被扩展重新加载后仍存活，这里做一次低频兜底检查
  pushRules(true);
  setInterval(function () {
    pushRules(false);
  }, 15000);
  document.addEventListener('DOMContentLoaded', function () {
    pushRules(true);
  });
})();
