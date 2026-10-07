/**
 * douyin-plus 存储层：设置、规则、统计的统一读写入口。
 * 依赖 schema.js（规则结构）与 chrome.storage。
 * 挂载点：globalThis.DouyinPlus.storage
 */
(function () {
  'use strict';

  const root = (globalThis.DouyinPlus = globalThis.DouyinPlus || {});
  if (root.storage) return;
  const schema = root.schema;

  const KEYS = {
    settings: 'settings',
    rules: 'rules',
    hiddenIds: 'hiddenIds',
    stats: 'stats'
  };

  /**
   * 远程规则订阅地址：默认走 jsDelivr CDN。
   * raw.githubusercontent.com 在部分网络环境（尤其国内）不可达，jsDelivr 有国内节点且会缓存仓库内容，
   * 更适合作为默认值。用户也可以改成 raw 地址或任意自建地址。
   */
  const DEFAULT_REMOTE_URL =
    'https://cdn.jsdelivr.net/gh/jeanhua/douyin-plus@main/rules/index.json';

  /** 默认地址的备用源：jsDelivr 拉取失败时按顺序重试 */
  const FALLBACK_REMOTE_URLS = [
    'https://raw.githubusercontent.com/jeanhua/douyin-plus/main/rules/index.json'
  ];

  const DEFAULT_SETTINGS = {
    enabled: true,
    targets: { danmaku: true, comment: true, live: true },
    /** DOM 兜底过滤：网络层没拦截到的（如缓存数据、直播弹幕长连接）用页面元素清理 */
    domFilter: true,
    builtinVersion: 0,
    /** 规则修订号，任何规则写入都会自增，内容脚本据此判断是否需要重新下发 */
    rulesRev: 1,
    remote: {
      url: DEFAULT_REMOTE_URL,
      enabled: false,
      intervalHours: 12,
      lastAt: 0,
      lastOk: null,
      lastError: '',
      lastVersion: 0,
      lastAdded: 0,
      lastCount: 0
    }
  };

  const STATS_KEEP_DAYS = 30;

  function storageGet(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (data) {
        resolve(data || {});
      });
    });
  }

  function storageSet(items) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(items, function () {
        resolve(true);
      });
    });
  }

  function deepMerge(target, patch) {
    const out = Object.assign({}, target);
    for (const key of Object.keys(patch || {})) {
      const value = patch[key];
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
        out[key] = deepMerge(target[key], value);
      } else if (value !== undefined) {
        out[key] = value;
      }
    }
    return out;
  }

  function todayKey(date) {
    const d = date || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** 读取全部状态，缺失字段用默认值补齐 */
  async function getState() {
    const data = await storageGet(Object.values(KEYS));
    const settings = deepMerge(DEFAULT_SETTINGS, data[KEYS.settings] || {});
    return {
      settings: settings,
      rules: Array.isArray(data[KEYS.rules]) ? data[KEYS.rules] : [],
      hiddenIds: Array.isArray(data[KEYS.hiddenIds]) ? data[KEYS.hiddenIds] : [],
      stats: data[KEYS.stats] || { total: 0, byDate: {}, byRule: {}, since: Date.now() }
    };
  }

  async function getSettings() {
    const data = await storageGet([KEYS.settings]);
    return deepMerge(DEFAULT_SETTINGS, data[KEYS.settings] || {});
  }

  async function saveSettings(patch) {
    const current = await getSettings();
    const next = deepMerge(current, patch);
    await storageSet({ [KEYS.settings]: next });
    return next;
  }

  async function getRules() {
    const data = await storageGet([KEYS.rules]);
    return Array.isArray(data[KEYS.rules]) ? data[KEYS.rules] : [];
  }

  async function saveRules(rules) {
    const data = await storageGet([KEYS.settings]);
    const settings = deepMerge(DEFAULT_SETTINGS, data[KEYS.settings] || {});
    settings.rulesRev = (Number(settings.rulesRev) || 0) + 1;
    await storageSet({ [KEYS.rules]: rules, [KEYS.settings]: settings });
    return rules;
  }

  async function getHiddenIds() {
    const data = await storageGet([KEYS.hiddenIds]);
    return Array.isArray(data[KEYS.hiddenIds]) ? data[KEYS.hiddenIds] : [];
  }

  async function addHiddenIds(ids) {
    const current = await getHiddenIds();
    const next = Array.from(new Set(current.concat(ids.filter(Boolean))));
    await storageSet({ [KEYS.hiddenIds]: next });
    return next;
  }

  async function removeHiddenIds(ids) {
    const set = new Set(ids);
    const current = await getHiddenIds();
    const next = current.filter((id) => !set.has(id));
    await storageSet({ [KEYS.hiddenIds]: next });
    return next;
  }

  /** 当前生效的规则（过滤掉停用项，供匹配引擎使用） */
  async function getEffectiveRules() {
    const all = await getRules();
    return all.filter((rule) => rule && rule.enabled !== false);
  }

  // ---------------------------------------------------------------- 统计

  async function getStats() {
    const data = await storageGet([KEYS.stats]);
    return data[KEYS.stats] || { total: 0, byDate: {}, byRule: {}, since: Date.now() };
  }

  /** 记录一次屏蔽；payload: { count, rules: [{id, name, pattern}], target } */
  async function recordBlocks(payload) {
    if (!payload || !payload.count) return null;
    const stats = await getStats();
    const key = todayKey();
    stats.total = (stats.total || 0) + payload.count;
    stats.byDate = stats.byDate || {};
    stats.byDate[key] = (stats.byDate[key] || 0) + payload.count;
    stats.byRule = stats.byRule || {};
    for (const rule of payload.rules || []) {
      const id = rule && rule.id;
      if (!id) continue;
      // 上报里带的是这条规则本次命中的条数，累加它而不是累加上报次数
      const hits = Number(rule.count) || 1;
      stats.byRule[id] = (stats.byRule[id] || 0) + hits;
    }
    // 顺手裁剪过期数据，避免无限增长
    const keepFrom = new Date(Date.now() - STATS_KEEP_DAYS * 86400000);
    const keepKey = todayKey(keepFrom);
    for (const date of Object.keys(stats.byDate)) {
      if (date < keepKey) delete stats.byDate[date];
    }

    // 角标：今日屏蔽数
    if (chrome.action && chrome.action.setBadgeText) {
      chrome.action.setBadgeBackgroundColor({ color: '#fe2c55' });
      chrome.action.setBadgeText({ text: String(stats.byDate[key] || 0) });
    }

    await storageSet({ [KEYS.stats]: stats });
    return stats;
  }

  async function resetStats() {
    await storageSet({ [KEYS.stats]: { total: 0, byDate: {}, byRule: {}, since: Date.now() } });
    if (chrome.action && chrome.action.setBadgeText) chrome.action.setBadgeText({ text: '' });
  }

  async function refreshBadge() {
    const stats = await getStats();
    if (!chrome.action || !chrome.action.setBadgeText) return;
    const count = (stats.byDate || {})[todayKey()] || 0;
    chrome.action.setBadgeBackgroundColor({ color: '#fe2c55' });
    chrome.action.setBadgeText({ text: count ? String(count) : '' });
  }

  // ---------------------------------------------------------------- 规则集写入

  /**
   * 用内置规则集刷新 storage 里的 builtin 规则。
   * - 保留用户对单条规则的启用状态
   * - 用户删除/改写过的内置规则（hiddenIds）不会复活
   */
  async function applyBuiltinRuleSet(ruleSet, options) {
    const opts = options || {};
    const bundledVersion = Number(ruleSet && ruleSet.version) || 0;
    const state = await getState();
    if (!opts.force && state.settings.builtinVersion === bundledVersion && state.rules.some((r) => r.source === 'builtin')) {
      return { changed: false, added: 0, removed: 0, version: bundledVersion };
    }

    const hidden = new Set(state.hiddenIds);
    const enabledById = new Map();
    for (const rule of state.rules) {
      if (rule.source === 'builtin') enabledById.set(rule.id, rule.enabled !== false);
    }

    const incoming = (ruleSet.rules || []).map((raw) => {
      const rule = schema.normalizeRule(raw, { defaultSource: 'builtin' });
      if (!rule) return null;
      rule.source = 'builtin';
      if (enabledById.has(rule.id)) rule.enabled = enabledById.get(rule.id);
      return rule;
    }).filter(Boolean);

    const kept = state.rules.filter((rule) => rule.source !== 'builtin');
    const keptIds = new Set(kept.map((rule) => rule.id));
    const restored = incoming.filter((rule) => !hidden.has(rule.id) && !keptIds.has(rule.id));
    // 内置规则排在前面，顺序与 default-rules.json 一致，便于在管理页对照
    const rules = restored.concat(kept);

    await saveRules(rules);
    await saveSettings({ builtinVersion: bundledVersion });
    return { changed: true, added: restored.length, removed: state.rules.length - kept.length, version: bundledVersion };
  }

  /**
   * 应用远程规则集：整体替换 source === 'remote' 的规则。
   *
   * 远程规则文件通常不写 id，每次导入生成的 id 都不一样，
   * 所以"用户的停用状态"按规则内容（type + pattern）匹配保留，而不是按 id。
   */
  async function applyRemoteRuleSet(ruleSet, meta) {
    const state = await getState();
    const hidden = new Set(state.hiddenIds);
    const enabledByBody = new Map();
    for (const rule of state.rules) {
      if (rule.source !== 'remote') continue;
      enabledByBody.set(rule.type + '\u0001' + rule.pattern, rule.enabled !== false);
    }

    const incoming = (ruleSet.rules || []).map((raw) => {
      const rule = schema.normalizeRule(raw, { defaultSource: 'remote' });
      if (!rule) return null;
      rule.source = 'remote';
      rule.remoteName = ruleSet.name || '';
      const body = rule.type + '\u0001' + rule.pattern;
      if (enabledByBody.has(body)) rule.enabled = enabledByBody.get(body);
      return rule;
    }).filter(Boolean);

    const kept = state.rules.filter((rule) => rule.source !== 'remote');
    const keptIds = new Set(kept.map((rule) => rule.id));
    const added = incoming.filter((rule) => !hidden.has(rule.id) && !keptIds.has(rule.id));

    await saveRules(kept.concat(added));
    await saveSettings({
      remote: Object.assign({}, state.settings.remote, {
        lastAt: Date.now(),
        lastOk: true,
        lastError: '',
        lastVersion: Number(ruleSet.rulesetVersion) || Number(ruleSet.version) || 0,
        lastAdded: added.length,
        lastCount: incoming.length
      })
    });
    return { replaced: state.rules.filter((r) => r.source === 'remote').length, added: added.length, total: incoming.length };
  }

  async function setRemoteError(message) {
    await saveSettings({
      remote: { lastAt: Date.now(), lastOk: false, lastError: String(message || 'unknown error').slice(0, 300) }
    });
  }

  root.storage = {
    KEYS: KEYS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_REMOTE_URL: DEFAULT_REMOTE_URL,
    FALLBACK_REMOTE_URLS: FALLBACK_REMOTE_URLS,
    todayKey: todayKey,
    getState: getState,
    getSettings: getSettings,
    saveSettings: saveSettings,
    getRules: getRules,
    saveRules: saveRules,
    getEffectiveRules: getEffectiveRules,
    getHiddenIds: getHiddenIds,
    addHiddenIds: addHiddenIds,
    removeHiddenIds: removeHiddenIds,
    getStats: getStats,
    recordBlocks: recordBlocks,
    resetStats: resetStats,
    refreshBadge: refreshBadge,
    applyBuiltinRuleSet: applyBuiltinRuleSet,
    applyRemoteRuleSet: applyRemoteRuleSet,
    setRemoteError: setRemoteError
  };
})();
