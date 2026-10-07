/**
 * douyin-plus 网络拦截（MAIN world）
 *
 * 在页面上下文劫持 fetch / XMLHttpRequest，直接过滤抖音弹幕、评论接口返回的 JSON，
 * 让被屏蔽的内容在进入页面之前就消失（不会闪一下就消失，也不会占用列表条数）。
 *
 * 通信：
 *   ISOLATED world（bridge.js） --window.postMessage({source:'douyin-plus',type:'rules'})--> 本文件
 *   本文件 --window.postMessage({source:'douyin-plus-main',type:'blocked'})--> ISOLATED world 统计
 */
(function () {
  'use strict';

  const root = (globalThis.DouyinPlus = globalThis.DouyinPlus || {});
  const matcher = root.matcher;
  if (!matcher || root.interceptorInstalled) return;
  root.interceptorInstalled = true;

  const CHANNEL_IN = 'douyin-plus'; // 来自扩展
  const CHANNEL_OUT = 'douyin-plus-main'; // 发往扩展

  /** 需要拦截的接口与对应场景 */
  const ENDPOINTS = [
    { target: 'danmaku', re: /\/aweme\/v1\/web\/danmaku\//i },
    { target: 'danmaku', re: /\/aweme\/v1\/web\/danmaku\/get/i },
    { target: 'comment', re: /\/aweme\/v1\/web\/comment\//i },
    { target: 'comment', re: /\/aweme\/v1\/web\/comment\/list/i }
  ];

  const state = {
    ready: false,
    enabled: true,
    targets: { danmaku: true, comment: true, live: true },
    matchers: {},
    /** 调试用：累计拦截条数 */
    blocked: 0,
    hits: 0
  };

  function targetOf(url) {
    if (!url || url.indexOf('/aweme/') === -1) return null;
    for (const item of ENDPOINTS) {
      if (item.re.test(url)) return item.target;
    }
    return null;
  }

  /** 只对配置里打开的场景做过滤 */
  function matcherFor(target) {
    if (!state.ready || !state.enabled) return null;
    if (state.targets[target] === false) return null;
    return state.matchers[target] || null;
  }

  function rebuild(rules, settings) {
    state.enabled = !settings || settings.enabled !== false;
    state.targets = Object.assign({ danmaku: true, comment: true, live: true }, (settings && settings.targets) || {});
    state.matchers = {};
    const list = Array.isArray(rules) ? rules : [];
    for (const target of matcher.TARGETS) {
      state.matchers[target] = matcher.createMatcher(list, target);
    }
    state.ready = true;
  }

  // ------------------------------------------------------------- 命中上报

  let pending = { count: 0, rules: {}, samples: [] };
  let flushTimer = 0;

  function report(result) {
    if (!result || !result.removed) return;
    state.blocked += result.removed;
    state.hits++;
    pending.count += result.removed;
    for (const id of Object.keys(result.rules || {})) {
      const entry = result.rules[id];
      if (!pending.rules[id]) pending.rules[id] = { id: id, name: entry.name, pattern: entry.pattern, count: 0 };
      pending.rules[id].count += entry.count;
    }
    for (const sample of result.samples || []) {
      if (pending.samples.length < 5) pending.samples.push(sample);
    }
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = 0;
      flush();
    }, 400);
  }

  function flush() {
    if (!pending.count) return;
    const payload = {
      source: CHANNEL_OUT,
      type: 'blocked',
      origin: 'network',
      count: pending.count,
      rules: Object.keys(pending.rules).map((id) => pending.rules[id]),
      samples: pending.samples
    };
    pending = { count: 0, rules: {}, samples: [] };
    postToExtension(payload);
  }

  function postToExtension(payload) {
    try {
      window.postMessage(payload, window.location.origin);
    } catch (_) {
      try {
        window.postMessage(payload, '*');
      } catch (__) {}
    }
  }

  // ------------------------------------------------------------- 过滤逻辑

  /**
   * 过滤一段 JSON 文本，返回 { text, removed, rules, samples } 或 null（无需改动）
   */
  function filterText(text, target) {
    const m = matcherFor(target);
    if (!m || !m.size) return null;
    if (typeof text !== 'string' || text.length < 2) return null;
    return matcher.filterJsonText(text, m);
  }

  // ------------------------------------------------------------- fetch

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      const url =
        typeof input === 'string'
          ? input
          : input && input.url
          ? String(input.url)
          : '';
      const target = targetOf(url);
      const promise = nativeFetch.apply(this, arguments);
      // 没有命中接口、或该场景没有启用规则时，完全不碰响应体
      if (!target || !matcherFor(target)) return promise;

      return promise.then(function (response) {
        try {
          if (!response || !response.ok || response.bodyUsed) return response;
          return response
            .clone()
            .text()
            .then(function (text) {
              const result = filterText(text, target);
              if (!result) return response;
              report(result);
              const headers = new Headers(response.headers);
              // 内容已被改写，压缩/长度相关的头必须丢掉，否则新 Response 会解码失败
              headers.delete('content-encoding');
              headers.delete('content-length');
              headers.delete('content-md5');
              return new Response(result.text, {
                status: response.status,
                statusText: response.statusText,
                headers: headers
              });
            })
            .catch(function () {
              return response;
            });
        } catch (_) {
          return response;
        }
      });
    };
  }

  // ------------------------------------------------------------- XMLHttpRequest

  const NativeXHR = window.XMLHttpRequest;
  if (typeof NativeXHR === 'function') {
    function DypXHR() {
      const xhr = new NativeXHR();
      let url = '';
      const nativeOpen = xhr.open;
      xhr.open = function (method, requestUrl) {
        url = requestUrl == null ? '' : String(requestUrl);
        return nativeOpen.apply(xhr, arguments);
      };

      xhr.addEventListener('readystatechange', function () {
        if (xhr.readyState !== 4 || !url) return;
        const target = targetOf(url);
        if (!target || !matcherFor(target)) return;
        try {
          const responseType = xhr.responseType;
          if (responseType === '' || responseType === 'text') {
            const text = xhr.responseText;
            const result = filterText(text, target);
            if (!result) return;
            const frozen = result.text;
            Object.defineProperty(xhr, 'responseText', { get: () => frozen, configurable: true });
            Object.defineProperty(xhr, 'response', { get: () => frozen, configurable: true });
            report(result);
          } else if (responseType === 'json') {
            const data = xhr.response;
            if (!data || typeof data !== 'object') return;
            const m = matcherFor(target);
            const result = matcher.filterValue(data, m);
            if (!result.removed) return;
            report(result);
          }
        } catch (_) {
          /* 保持页面行为不受影响 */
        }
      });

      return xhr;
    }

    DypXHR.prototype = NativeXHR.prototype;
    for (const key of Object.getOwnPropertyNames(NativeXHR)) {
      if (!(key in DypXHR)) {
        try {
          DypXHR[key] = NativeXHR[key];
        } catch (_) {}
      }
    }
    try {
      Object.defineProperty(window, 'XMLHttpRequest', { value: DypXHR, configurable: true, writable: true });
    } catch (_) {
      window.XMLHttpRequest = DypXHR;
    }
  }

  // ------------------------------------------------------------- 接收规则

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL_IN) return;
    if (data.type === 'rules') {
      try {
        rebuild(data.rules, data.settings);
        flush();
      } catch (err) {
        // 规则下发失败时保持旧规则，不影响页面
        console.warn('[douyin-plus] 规则应用失败', err);
      }
      return;
    }
    if (data.type === 'ping') {
      post({ type: 'pong', ready: state.ready, blocked: state.blocked });
    }
  });

  function post(payload) {
    payload.source = CHANNEL_OUT;
    try {
      window.postMessage(payload, window.location.origin);
    } catch (_) {
      try {
        window.postMessage(payload, '*');
      } catch (__) {}
    }
  }

  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });

  // 调试入口
  root.network = {
    targetOf: targetOf,
    stats: function () {
      return { blocked: state.blocked, hits: state.hits, ready: state.ready, matcherSizes: Object.keys(state.matchers).map((k) => k + ':' + state.matchers[k].size) };
    }
  };
})();
