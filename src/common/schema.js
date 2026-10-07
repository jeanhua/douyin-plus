/**
 * douyin-plus 规则数据结构 / 导入导出格式
 *
 * 不依赖 chrome.* API，可在 content script、popup、options、service worker 中复用。
 * 挂载点：globalThis.DouyinPlus.schema
 */
(function () {
  'use strict';

  const root = (globalThis.DouyinPlus = globalThis.DouyinPlus || {});
  if (root.schema) return;

  const SCHEMA_VERSION = 1;
  const SOURCES = ['builtin', 'user', 'remote'];
  const ACTIONS = ['hide', 'blur'];

  /** 规则可选的目标场景，含义见 docs/RULES.md */
  const TARGET_KEYS = ['danmaku', 'comment', 'live'];

  function uid(prefix) {
    let rand;
    try {
      rand = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    } catch (_) {
      rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    }
    return (prefix || 'r') + '_' + rand;
  }

  function str(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function bool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function allTargets(value) {
    return { danmaku: !!value, comment: !!value, live: !!value };
  }

  /**
   * 归一化生效场景。规则里没写 targets 时按 fallbackAll 处理；
   * 显式写了就只认写出来的，没写的场景视为不生效（避免"只写给评论"变成三处都命中）。
   */
  function normalizeTargets(raw, fallbackAll) {
    if (raw == null) return allTargets(!!fallbackAll);
    if (typeof raw === 'boolean') return allTargets(raw);

    if (Array.isArray(raw)) {
      const out = allTargets(false);
      for (const item of raw) {
        const key = str(item).toLowerCase();
        if (key === 'all' || key === '*') return allTargets(true);
        if (TARGET_KEYS.includes(key)) out[key] = true;
      }
      return out;
    }

    if (typeof raw === 'object') {
      if (raw.all === true) return allTargets(true);
      if (raw.all === false) return allTargets(false);
      const out = allTargets(false);
      let touched = 0;
      for (const key of TARGET_KEYS) {
        if (typeof raw[key] === 'boolean') {
          out[key] = raw[key];
          touched++;
        }
      }
      return touched ? out : allTargets(!!fallbackAll);
    }

    const key = str(raw).toLowerCase();
    if (key === 'all' || key === '*') return allTargets(true);
    if (TARGET_KEYS.includes(key)) {
      const out = allTargets(false);
      out[key] = true;
      return out;
    }
    return allTargets(!!fallbackAll);
  }

  /**
   * 把各种"野生格式"的规则统一成内部结构，无法识别时返回 null。
   * 兼容写法：keyword / keywordText / text / words[] / regex / re / pattern + type
   */
  function normalizeRule(raw, opts) {
    const options = opts || {};
    if (typeof raw === 'string') raw = { pattern: raw };
    if (!raw || typeof raw !== 'object') return null;

    let type = str(raw.type || raw.mode).toLowerCase();
    let pattern = '';

    if (Array.isArray(raw.words) || Array.isArray(raw.keywords)) {
      const words = (raw.words || raw.keywords).map(str).filter(Boolean);
      if (words.length) {
        pattern = words.join('\n');
        type = 'keyword';
      }
    }
    if (!pattern) {
      pattern =
        str(raw.pattern) ||
        str(raw.regex) ||
        str(raw.keyword) ||
        str(raw.keywords) ||
        str(raw.text) ||
        str(raw.value) ||
        str(raw.match);
    }
    if (!pattern) return null;

    if (type !== 'regex' && type !== 'keyword') {
      // 未声明类型时：带 regex/re 字段的按正则处理，其余按关键词处理
      type = raw.regex || raw.re ? 'regex' : 'keyword';
      if (raw.isRegex === true) type = 'regex';
      if (raw.isRegex === false) type = 'keyword';
    }

    const now = Date.now();
    const isRegex = type === 'regex';
    const targetsRaw = raw.targets != null ? raw.targets : raw.scope != null ? raw.scope : raw.scene;
    const fallbackAll = options.defaultTargetsAll !== false;

    let caseSensitive;
    if (typeof raw.caseSensitive === 'boolean') caseSensitive = raw.caseSensitive;
    else if (typeof raw.ignoreCase === 'boolean') caseSensitive = !raw.ignoreCase;
    else caseSensitive = false;

    return {
      id: str(raw.id) || uid(),
      name: str(raw.name || raw.label || raw.title) || (isRegex ? '正则规则' : '关键词规则'),
      pattern: pattern,
      type: type,
      caseSensitive: caseSensitive,
      targets: normalizeTargets(targetsRaw, fallbackAll),
      action: ACTIONS.includes(str(raw.action)) ? str(raw.action) : 'hide',
      enabled: bool(raw.enabled, true),
      source: SOURCES.includes(str(raw.source)) ? str(raw.source) : options.defaultSource || 'user',
      note: str(raw.note || raw.description || raw.desc),
      createdAt: Number(raw.createdAt) || now,
      updatedAt: Number(raw.updatedAt) || now
    };
  }

  /** 判断一个 JSON 是什么格式：ruleset | index | simple | array | unknown */
  function detectFormat(json) {
    if (Array.isArray(json)) return 'array';
    if (!json || typeof json !== 'object') return 'unknown';
    if (Array.isArray(json.rules)) return 'ruleset';
    if (Array.isArray(json.files) || Array.isArray(json.sets)) return 'index';
    if (Array.isArray(json.keywords) || Array.isArray(json.regex) || Array.isArray(json.blacklist)) {
      return 'simple';
    }
    return 'unknown';
  }

  /** 把 simple 格式（{keywords: [], regex: []}）转成规则数组 */
  function fromSimple(json) {
    const rules = [];
    const push = (list, type) => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        const rule = normalizeRule(
          typeof item === 'object' ? Object.assign({}, item, { type: type }) : { pattern: item, type: type },
          { defaultSource: 'user' }
        );
        if (rule) rules.push(rule);
      }
    };
    push(json.keywords || json.blacklist, 'keyword');
    push(json.regex, 'regex');
    return rules;
  }

  /**
   * 标准化为规则集对象。
   * @returns {{ name, description, author, homepage, version, updatedAt, rules, warnings }}
   */
  function normalizeRuleSet(json, opts) {
    const options = opts || {};
    const warnings = [];
    const format = detectFormat(json);
    let rawRules = [];
    let meta = {};

    if (format === 'array') {
      rawRules = json;
    } else if (format === 'ruleset') {
      rawRules = json.rules;
      meta = json;
    } else if (format === 'simple') {
      rawRules = fromSimple(json);
      meta = json;
    } else if (format === 'unknown' && json && typeof json === 'object' && json.data) {
      return normalizeRuleSet(json.data, opts);
    } else {
      warnings.push('无法识别的规则文件格式');
    }

    const rules = [];
    for (const raw of rawRules) {
      const rule = normalizeRule(raw, {
        defaultSource: options.defaultSource || 'user',
        defaultTargetsAll: options.defaultTargetsAll
      });
      if (rule) rules.push(rule);
      else warnings.push('跳过一条无法解析的规则：' + JSON.stringify(raw).slice(0, 80));
    }

    return {
      format: format,
      name: str(meta.name) || options.defaultName || '导入的规则集',
      description: str(meta.description) || '',
      author: str(meta.author) || '',
      homepage: str(meta.homepage || meta.url) || '',
      version: Number(meta.version) || SCHEMA_VERSION,
      rulesetVersion: Number(meta.rulesetVersion) || Number(meta.version) || 0,
      updatedAt: str(meta.updatedAt) || '',
      rules: rules,
      warnings: warnings
    };
  }

  /** 导出为规则集 JSON 字符串 */
  function toRuleSet(rules, meta) {
    const info = meta || {};
    return JSON.stringify(
      {
        schema: 'douyin-plus/ruleset',
        schemaVersion: SCHEMA_VERSION,
        name: info.name || 'douyin-plus 规则导出',
        description: info.description || '',
        author: info.author || '',
        homepage: info.homepage || '',
        version: Number(info.version) || SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        count: rules.length,
        rules: rules.map(function (rule) {
          return {
            id: rule.id,
            name: rule.name,
            pattern: rule.pattern,
            type: rule.type,
            caseSensitive: !!rule.caseSensitive,
            targets: rule.targets,
            action: rule.action,
            enabled: rule.enabled !== false,
            note: rule.note || ''
          };
        })
      },
      null,
      2
    );
  }

  /** 规则的业务判重键：同 id 或同类型同内容视为同一条 */
  function ruleKeys(rule) {
    const keys = [];
    if (rule.id) keys.push('id:' + rule.id);
    keys.push('body:' + rule.type + '\u0001' + (rule.caseSensitive ? 's' : 'i') + '\u0001' + rule.pattern);
    return keys;
  }

  /**
   * 合并规则。
   * @param {Array}  base     已有规则（不会被修改）
   * @param {Array}  incoming 新规则
   * @param {Object} options  { skipDuplicates: boolean, source: 'user'|'remote' }
   * @returns {{ rules: Array, added: number, updated: number, skipped: number }}
   */
  function mergeRules(base, incoming, options) {
    const opts = options || {};
    const skipDuplicates = opts.skipDuplicates !== false;
    const source = opts.source;
    const result = base.slice();
    const index = new Map();
    result.forEach(function (rule, i) {
      ruleKeys(rule).forEach(function (key) {
        if (!index.has(key)) index.set(key, i);
      });
    });

    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const raw of incoming) {
      const rule = normalizeRule(raw, { defaultSource: source || 'user' });
      if (!rule) {
        skipped++;
        continue;
      }
      if (source) rule.source = source;

      const hitKey = ruleKeys(rule).find(function (key) {
        return index.has(key);
      });

      if (hitKey === undefined) {
        index.set(ruleKeys(rule)[0], result.length);
        result.push(rule);
        added++;
        continue;
      }

      if (skipDuplicates) {
        skipped++;
        continue;
      }

      const at = index.get(hitKey);
      const merged = Object.assign({}, result[at], rule, {
        id: result[at].id,
        createdAt: result[at].createdAt,
        updatedAt: Date.now()
      });
      result[at] = merged;
      updated++;
    }

    return { rules: result, added: added, updated: updated, skipped: skipped };
  }

  root.schema = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    SOURCES: SOURCES,
    ACTIONS: ACTIONS,
    TARGET_KEYS: TARGET_KEYS,
    uid: uid,
    normalizeRule: normalizeRule,
    normalizeTargets: normalizeTargets,
    detectFormat: detectFormat,
    fromSimple: fromSimple,
    normalizeRuleSet: normalizeRuleSet,
    toRuleSet: toRuleSet,
    mergeRules: mergeRules,
    ruleKeys: ruleKeys
  };
})();
