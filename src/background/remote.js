/**
 * douyin-plus 远程规则拉取
 *
 * 支持三种订阅形态：
 *  1. 规则集文件（ruleset / 规则数组 / {keywords, regex} 简写）—— 直接使用；
 *  2. 索引文件（含 files 列表）—— 逐个拉取其中 enabled 的文件并合并；
 *  3. GitHub 网页地址（github.com/.../blob/...）—— 自动转换为 raw 地址。
 *
 * 本文件同时被 service worker 与设置页加载：设置页只用 normalizeUrl / ensureHostPermission，
 * service worker 用完整的拉取逻辑。因此对 storage / schema 的依赖在函数内惰性取用。
 *
 * 挂载点：globalThis.DouyinPlus.remote
 */
(function () {
  'use strict';

  const root = (globalThis.DouyinPlus = globalThis.DouyinPlus || {});
  if (root.remote) return;

  const FETCH_TIMEOUT = 20000;
  const MAX_FILES = 30;
  const MAX_BYTES = 8 * 1024 * 1024;

  /** 打包时已声明权限的域名（浏览器会自动判断是否覆盖目标地址，这里仅作文档参考） */
  const BUILTIN_HOSTS = [
    'https://*.douyin.com/*',
    'https://raw.githubusercontent.com/*',
    'https://github.com/*',
    'https://cdn.jsdelivr.net/*',
    'https://gitee.com/*'
  ];

  function getSchema() {
    return root.schema;
  }

  function getStorage() {
    return root.storage;
  }

  /** 把常见的仓库网页地址转换成可直接 fetch 的地址 */
  function normalizeUrl(input) {
    let url = String(input || '').trim();
    if (!url) return '';
    if (url.startsWith('//')) url = 'https:' + url;

    // github.com/user/repo/blob/branch/path -> raw.githubusercontent.com/user/repo/branch/path
    const gh = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/i);
    if (gh) return 'https://raw.githubusercontent.com/' + gh[1] + '/' + gh[2] + '/' + gh[3];

    // jsdelivr 网页地址 gh/user/repo@branch/path -> cdn.jsdelivr.net/gh/...
    const jd = url.match(/^https?:\/\/(?:www\.)?jsdelivr\.net\/gh\/(.+)$/i);
    if (jd) return 'https://cdn.jsdelivr.net/gh/' + jd[1];

    if (!/^https?:\/\//i.test(url)) {
      // 允许只填 user/repo 或 user/repo/path
      const parts = url.split('/').filter(Boolean);
      if (parts.length >= 2) {
        const rest = parts.slice(2).join('/');
        return 'https://raw.githubusercontent.com/' + parts[0] + '/' + parts[1] + '/main/' + (rest || 'rules/index.json');
      }
      return '';
    }
    return url;
  }

  function originPattern(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
      return parsed.protocol + '//' + parsed.hostname + '/*';
    } catch (_) {
      return '';
    }
  }

  /**
   * 确保已获得访问该地址的权限。返回 true 表示可以 fetch。
   * 必须在用户手势（按钮点击）的调用栈里执行，浏览器才会弹出授权框。
   */
  async function ensureHostPermission(url) {
    const target = normalizeUrl(url);
    if (!target) return false;
    const pattern = originPattern(target);
    if (!pattern) return false;

    // 打包时声明的域名（含 *.douyin.com 这类通配）由浏览器自行判断是否覆盖 pattern
    if (!chrome.permissions || !chrome.permissions.contains) return true;

    try {
      if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    } catch (_) {
      return true; // 权限 API 不可用时不阻塞流程，让 fetch 自己去失败
    }

    try {
      return await chrome.permissions.request({ origins: [pattern] });
    } catch (_) {
      return false;
    }
  }

  async function fetchText(url, options) {
    const opts = options || {};
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(function () {
      if (controller) controller.abort();
    }, opts.timeout || FETCH_TIMEOUT);

    try {
      const response = await fetch(url, {
        cache: opts.noCache ? 'no-store' : 'default',
        credentials: 'omit',
        redirect: 'follow',
        signal: controller ? controller.signal : undefined
      });
      if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText);
      const text = await response.text();
      if (text.length > MAX_BYTES) throw new Error('规则文件过大（' + Math.round(text.length / 1024) + ' KB）');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  function joinUrl(base, path) {
    if (/^https?:\/\//i.test(path)) return path;
    try {
      return new URL(path, base).href;
    } catch (_) {
      return path;
    }
  }

  /** 拉取并解析一个规则集文件 */
  async function fetchRuleSet(url, options) {
    const target = normalizeUrl(url);
    if (!target) throw new Error('规则地址无效');
    const text = await fetchText(target, options);
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error('规则文件不是合法 JSON：' + (err && err.message ? err.message : ''));
    }
    const ruleSet = getSchema().normalizeRuleSet(json, { defaultSource: 'remote', defaultName: target.split('/').pop() });
    ruleSet.url = target;
    if (!ruleSet.rules.length) throw new Error('规则文件里没有可用规则');
    return ruleSet;
  }

  /**
   * 拉取订阅地址对应的规则：索引文件会展开成多个规则集。
   * @returns {{ ruleSets: Array, warnings: string[] }}
   */
  async function fetchSubscription(url, options) {
    const opts = options || {};
    const target = normalizeUrl(url);
    if (!target) throw new Error('规则地址无效');
    const text = await fetchText(target, opts);
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error('订阅地址返回的不是合法 JSON：' + (err && err.message ? err.message : ''));
    }

    const format = getSchema().detectFormat(json);
    const warnings = [];

    if (format !== 'index') {
      const ruleSet = getSchema().normalizeRuleSet(json, { defaultSource: 'remote', defaultName: json && json.name });
      ruleSet.url = target;
      if (!ruleSet.rules.length) throw new Error('规则文件里没有可用规则');
      return { ruleSets: [ruleSet], warnings };
    }

    const files = (json.files || json.sets || []).slice(0, MAX_FILES);
    const enabledFiles = files.filter((file) => file && file.enabled !== false);
    const ruleSets = [];

    for (const file of enabledFiles) {
      const fileUrl = joinUrl(target, file.path || file.url || '');
      if (!fileUrl) continue;
      try {
        const ruleSet = await fetchRuleSet(fileUrl, opts);
        if (file.name) ruleSet.name = ruleSet.name || file.name;
        ruleSets.push(ruleSet);
      } catch (err) {
        warnings.push((file.path || fileUrl) + '：' + (err && err.message ? err.message : String(err)));
      }
    }

    if (!ruleSets.length) throw new Error(warnings.length ? '全部规则文件拉取失败：' + warnings[0] : '索引里没有启用的规则文件');
    warnings.push.apply(warnings, []);
    return { ruleSets: ruleSets, warnings: warnings };
  }

  /** 合并多个规则集为一个（用于整体替换 remote 规则） */
  function mergeRuleSets(ruleSets, indexJson) {
    const rules = [];
    const seen = new Set();
    for (const ruleSet of ruleSets) {
      for (const rule of ruleSet.rules) {
        const key = rule.type + '\u0001' + rule.pattern;
        if (seen.has(key)) continue;
        seen.add(key);
        rules.push(rule);
      }
    }
    const version = ruleSets.reduce(function (max, rs) {
      return Math.max(max, Number(rs.rulesetVersion) || Number(rs.version) || 0);
    }, 0);
    return {
      name: indexJson && indexJson.name ? indexJson.name : ruleSets[0] && ruleSets[0].name ? ruleSets[0].name : '远程规则',
      rules: rules,
      version: version,
      rulesetVersion: version,
      updatedAt: (indexJson && indexJson.updatedAt) || new Date().toISOString()
    };
  }

/**
 * 尝试一次订阅更新（不做失败记录），成功返回结果，失败抛出错误。
 */
async function tryUpdate(target, opts) {
  const subscribed = await fetchSubscription(target, { noCache: opts.noCache !== false });
  const merged = mergeRuleSets(subscribed.ruleSets, opts.indexJson);
  const result = await getStorage().applyRemoteRuleSet(merged, { url: target });
  return {
    ok: true,
    url: target,
    warnings: subscribed.warnings,
    stats: result,
    name: merged.name,
    rules: merged.rules.length,
    files: subscribed.ruleSets.length
  };
}

/**
 * 执行一次订阅更新并写入存储。
 *
 * 当订阅地址就是内置默认地址时，主源失败会依次重试备用源
 * （默认主源是 jsDelivr，备用是 raw.githubusercontent.com）。
 * 用户自己填的地址不会做这种替换，避免"我明明填了 A 却从 B 拉数据"。
 *
 * @returns {{ ok: boolean, error?: string, warnings?: string[] }}
 */
async function updateFromRemote(url, options) {
  const opts = options || {};
  const settings = await getStorage().getSettings();
  const configured = String(url || settings.remote.url || '').trim();
  const target = normalizeUrl(configured);
  if (!target) {
    const error = '未配置订阅地址';
    await getStorage().setRemoteError(error);
    return { ok: false, error: error };
  }

  const storageApi = getStorage();
  const isDefaultUrl = normalizeUrl(storageApi.DEFAULT_REMOTE_URL) === target;
  const candidates = [target];
  if (isDefaultUrl) {
    for (const fallback of storageApi.FALLBACK_REMOTE_URLS || []) {
      const normalized = normalizeUrl(fallback);
      if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
    }
  }

  const failures = [];
  for (const candidate of candidates) {
    try {
      const result = await tryUpdate(candidate, opts);
      if (candidate !== target) {
        console.info('[douyin-plus] 主订阅源不可用，已改用备用源：' + candidate);
        result.usedFallback = true;
        result.primaryUrl = target;
      }
      return result;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      failures.push(candidate === target ? message : candidate + '：' + message);
    }
  }

  const finalError = failures[0] || '未知错误';
  await storageApi.setRemoteError(finalError);
  if (candidates.length > 1) {
    console.warn('[douyin-plus] 订阅源全部失败：' + failures.join(' | '));
  }
  return { ok: false, error: finalError, failures: failures };
}

root.remote = {
  BUILTIN_HOSTS: BUILTIN_HOSTS,
  normalizeUrl: normalizeUrl,
  originPattern: originPattern,
  ensureHostPermission: ensureHostPermission,
  fetchText: fetchText,
  fetchRuleSet: fetchRuleSet,
  fetchSubscription: fetchSubscription,
  mergeRuleSets: mergeRuleSets,
  updateFromRemote: updateFromRemote
};
})();
