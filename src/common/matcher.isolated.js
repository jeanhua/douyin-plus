/**
 * douyin-plus 规则匹配引擎
 *
 * Chrome 对同一路径的内容脚本只会注入一次（跨 world 去重）：同一文件同时登记在
 * MAIN 与 ISOLATED 两个 content_scripts 里时，ISOLATED world 拿不到它。
 * 因此这里有两份内容完全一致的文件，改动必须同步：
 *   - matcher.js            MAIN world 网络拦截 + 设置页 / 快捷面板
 *   - matcher.isolated.js   ISOLATED world DOM 兜底过滤
 * tools/test.js 会校验两份文件逐字节一致。
 *
 * 不能依赖任何 chrome.* API，也不能使用 ES module 语法。
 * 挂载点：globalThis.DouyinPlus.matcher
 */
(function () {
  'use strict';

  const root = (globalThis.DouyinPlus = globalThis.DouyinPlus || {});
  if (root.matcher) return;

  /** 支持屏蔽的目标场景 */
  const TARGETS = ['danmaku', 'comment', 'live'];

  /** 单条规则 pattern 的长度上限，避免误粘贴超大文本导致正则编译/回溯灾难 */
  const MAX_PATTERN_LENGTH = 500;

  /** JSON 里可能承载文本内容的字段名（按优先级） */
  const TEXT_FIELDS = [
    'text',
    'content',
    'danmaku_text',
    'content_text',
    'reply_text',
    'display_text',
    'desc'
  ];

  const REGEX_CACHE = new Map();
  const MAX_REGEX_CACHE = 4000;

  function escapeLiteral(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 关键词规则支持一次填写多个词（换行 / 英文逗号 / 中文逗号分隔），任意命中即屏蔽。
   * 正则规则不做拆分。
   */
  function toRegexSource(pattern, type) {
    if (type === 'regex') return pattern;
    const parts = String(pattern)
      .split(/[\n\r,，]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return '';
    return parts.map(escapeLiteral).join('|');
  }

  /**
   * 编译单条规则，返回 RegExp；非法正则返回 null。
   * 编译结果带缓存，规则未变化时不会重复 new RegExp。
   */
  function compilePattern(pattern, type, caseSensitive) {
    const raw = String(pattern == null ? '' : pattern).trim();
    if (!raw || raw.length > MAX_PATTERN_LENGTH) return null;

    const kind = type === 'regex' ? 'r' : 'k';
    const key = kind + (caseSensitive ? 's' : 'i') + '\u0001' + raw;
    if (REGEX_CACHE.has(key)) return REGEX_CACHE.get(key);

    let re = null;
    const source = toRegexSource(raw, kind === 'r' ? 'regex' : 'keyword');
    if (source) {
      try {
        re = new RegExp(source, caseSensitive ? '' : 'i');
      } catch (_) {
        re = null;
      }
    }

    if (REGEX_CACHE.size >= MAX_REGEX_CACHE) REGEX_CACHE.clear();
    REGEX_CACHE.set(key, re);
    return re;
  }

  /** 校验规则可编译性，返回错误信息或 null */
  function validatePattern(pattern, type, caseSensitive) {
    const raw = String(pattern == null ? '' : pattern).trim();
    if (!raw) return '匹配内容不能为空';
    if (raw.length > MAX_PATTERN_LENGTH) return `匹配内容过长（上限 ${MAX_PATTERN_LENGTH} 字）`;
    if (type === 'regex') {
      try {
        // eslint-disable-next-line no-new
        new RegExp(raw, caseSensitive ? '' : 'i');
      } catch (err) {
        return '正则表达式无效：' + (err && err.message ? err.message : String(err));
      }
    }
    return null;
  }

  /**
   * 判断规则在某场景是否生效。
   * 兼容 targets 的几种写法：对象、数组、单字符串、'all'、布尔。
   * 规则里完全没声明时视为全部场景生效。
   */
  function targetEnabled(targets, target) {
    if (targets == null) return true;
    if (typeof targets === 'boolean') return targets;

    if (Array.isArray(targets)) {
      if (!targets.length) return true;
      for (const item of targets) {
        const key = String(item).toLowerCase();
        if (key === 'all' || key === '*') return true;
        if (key === target) return true;
      }
      return false;
    }

    if (typeof targets === 'object') {
      if (targets.all === true) return true;
      if (targets.all === false) return false;
      if (!Object.prototype.hasOwnProperty.call(targets, target)) return true;
      return targets[target] !== false;
    }

    const key = String(targets).toLowerCase();
    if (key === 'all' || key === '*') return true;
    return key === target;
  }

  /**
   * 用一组规则构造匹配器。
   * @param {Array}  rules  规则数组
   * @param {string} target 目标场景（danmaku | comment | live），不传则不限场景
   */
  function createMatcher(rules, target) {
    const compiled = [];
    const list = Array.isArray(rules) ? rules : [];

    for (const rule of list) {
      if (!rule || rule.enabled === false) continue;
      if (target && !targetEnabled(rule.targets, target)) continue;
      const re = compilePattern(rule.pattern, rule.type, !!rule.caseSensitive);
      if (!re) continue;
      compiled.push({ rule: rule, re: re });
    }

    return {
      size: compiled.length,
      /** 返回命中的第一条规则，未命中返回 null */
      test: function (text) {
        if (text == null) return null;
        const str = typeof text === 'string' ? text : String(text);
        if (!str) return null;
        for (let i = 0; i < compiled.length; i++) {
          const entry = compiled[i];
          entry.re.lastIndex = 0;
          if (entry.re.test(str)) return entry.rule;
        }
        return null;
      },
      /** 返回命中的全部规则 */
      testAll: function (text) {
        const hits = [];
        if (text == null) return hits;
        const str = typeof text === 'string' ? text : String(text);
        if (!str) return hits;
        for (let i = 0; i < compiled.length; i++) {
          const entry = compiled[i];
          entry.re.lastIndex = 0;
          if (entry.re.test(str)) hits.push(entry.rule);
        }
        return hits;
      }
    };
  }

  /** 从对象里取出用于匹配的文本，取不到返回 null */
  function pickText(item) {
    if (!item || typeof item !== 'object') return null;
    for (let i = 0; i < TEXT_FIELDS.length; i++) {
      const value = item[TEXT_FIELDS[i]];
      if (typeof value === 'string' && value) return value;
    }
    return null;
  }

  /**
   * 深度过滤 JSON 对象：遍历所有数组，删除"文本命中规则"的数组项。
   * 只做数组项级别的删除，不删除任意对象的属性，尽量不影响接口数据结构。
   *
   * 只删除 action 为 hide 的命中项；action 为 blur 的命中必须保留在响应里，
   * 交给 DOM 过滤器加模糊样式——网络层删掉后内容不会渲染，悬停查看也就无从谈起。
   * @returns {{ removed: number, samples: string[], rules: Object }} removed = 本次过滤掉的条数
   */
  function filterValue(value, matcher, result) {
    const res = result || { removed: 0, samples: [], rules: {} };
    if (!res.rules) res.rules = {};
    if (!value || typeof value !== 'object') return res;

    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        const item = value[i];
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const text = pickText(item);
          const hit = text ? matcher.test(text) : null;
          if (hit && hit.action !== 'blur') {
            res.removed++;
            if (res.samples.length < 5) res.samples.push(text.slice(0, 80));
            const entry = res.rules[hit.id] || (res.rules[hit.id] = { count: 0, name: hit.name, pattern: hit.pattern, type: hit.type });
            entry.count++;
            value.splice(i, 1);
            continue;
          }
          // blur 命中项保留在原位，但仍要向下检查嵌套数组（如二级评论）
          filterValue(item, matcher, res);
        } else if (item && typeof item === 'object') {
          filterValue(item, matcher, res);
        }
      }
      return res;
    }

    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const child = value[key];
      if (child && typeof child === 'object') filterValue(child, matcher, res);
    }
    return res;
  }

  /**
   * 过滤 JSON 文本。解析失败或没有命中时返回 null（调用方应原样放行响应）。
   */
  function filterJsonText(text, matcher) {
    if (typeof text !== 'string' || !text) return null;
    // 快速失败：命中关键词多为一两个字符，先做一次粗筛
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return null;
    }
    const res = filterValue(data, matcher);
    if (!res.removed) return null;
    res.text = JSON.stringify(data);
    return res;
  }

  root.matcher = {
    TARGETS: TARGETS,
    TEXT_FIELDS: TEXT_FIELDS,
    MAX_PATTERN_LENGTH: MAX_PATTERN_LENGTH,
    escapeLiteral: escapeLiteral,
    compilePattern: compilePattern,
    validatePattern: validatePattern,
    createMatcher: createMatcher,
    targetEnabled: targetEnabled,
    pickText: pickText,
    filterValue: filterValue,
    filterJsonText: filterJsonText
  };
})();
