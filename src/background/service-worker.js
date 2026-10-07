/**
 * douyin-plus service worker
 *
 * 职责：
 *  - 安装/更新时把打包的默认规则写入 storage；
 *  - 定时（alarms）检查远程规则订阅；
 *  - 汇总内容脚本上报的屏蔽次数，维护角标；
 *  - 处理 popup / options 发来的指令。
 */

importScripts(
  '/src/common/matcher.js',
  '/src/common/schema.js',
  '/src/common/storage.js',
  '/src/background/remote.js'
);

const { storage, remote, schema, matcher } = globalThis.DouyinPlus;

const ALARM_REMOTE = 'dyp:remote-check';
const BUNDLED_RULESET = 'rules/default-rules.json';
const MENU_BLOCK_SELECTION = 'dyp:block-selection';

// ------------------------------------------------------------ 内置规则装载

/** 读取打包的默认规则并写入 storage（保留用户的启用状态与自定义修改） */
async function syncBuiltinRules(force) {
  try {
    const url = chrome.runtime.getURL(BUNDLED_RULESET);
    const response = await fetch(url, { cache: 'no-store' });
    const json = await response.json();
    const ruleSet = schema.normalizeRuleSet(json, { defaultSource: 'builtin', defaultName: '内置规则' });
    const result = await storage.applyBuiltinRuleSet(ruleSet, { force: !!force });
    if (result.changed) {
      console.info('[douyin-plus] 内置规则已同步：', result);
      await notifyTabs();
    }
    return result;
  } catch (err) {
    console.warn('[douyin-plus] 内置规则同步失败', err);
    return { changed: false, error: String(err && err.message ? err.message : err) };
  }
}

// ------------------------------------------------------------ 远程订阅

async function alarmRemoteCheck() {
  const settings = await storage.getSettings();
  if (!settings.remote || !settings.remote.enabled) return;
  const url = settings.remote.url;
  if (!url) return;
  // 定时任务里无法弹授权框；权限不足时记录失败原因，用户手动更新时会补上授权
  const allowed = await remote.ensureHostPermission(url);
  if (!allowed) {
    await storage.setRemoteError('缺少访问订阅地址的权限，请在设置页点"立即更新"完成授权');
    return;
  }
  const result = await remote.updateFromRemote(url);
  if (result.ok) {
    console.info('[douyin-plus] 远程规则已更新', result.stats);
    await notifyTabs();
  } else {
    console.warn('[douyin-plus] 远程规则更新失败：' + result.error);
  }
}

async function ensureAlarm() {
  const settings = await storage.getSettings();
  const hours = Math.max(1, Number(settings.remote && settings.remote.intervalHours) || 12);
  const existing = await chrome.alarms.get(ALARM_REMOTE).catch(() => null);
  if (settings.remote && settings.remote.enabled) {
    if (!existing || Math.abs((existing.periodInMinutes || 0) - hours * 60) > 1) {
      chrome.alarms.create(ALARM_REMOTE, { periodInMinutes: hours * 60, delayInMinutes: 1 });
    }
  } else if (existing) {
    chrome.alarms.clear(ALARM_REMOTE);
  }
}

// ------------------------------------------------------------ 让页面立即生效

async function notifyTabs() {
  const tabs = await chrome.tabs.query({ url: ['https://*.douyin.com/*'] }).catch(() => []);
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, { type: 'dyp:refresh' }).catch(() => {});
  }
}

async function refreshBadge() {
  await storage.refreshBadge();
}

// ------------------------------------------------------------ 右键菜单

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_BLOCK_SELECTION,
      title: 'douyin-plus：屏蔽选中关键词',
      contexts: ['selection']
    });
  });
}

// ------------------------------------------------------------ 生命周期

chrome.runtime.onInstalled.addListener(async (details) => {
  buildMenus();
  await syncBuiltinRules(details.reason === 'install' || details.reason === 'update');
  await ensureAlarm();
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  buildMenus();
  await syncBuiltinRules(false);
  await ensureAlarm();
  await refreshBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_REMOTE) alarmRemoteCheck();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) ensureAlarm();
});

// ------------------------------------------------------------ 消息接口

const handlers = {
  /** 内容脚本上报的屏蔽统计 */
  'dyp:blocks': async (message) => {
    return storage.recordBlocks({
      count: message.count,
      rules: message.rules,
      target: message.target,
      origin: message.origin
    });
  },
  'dyp:get-state': async () => {
    const state = await storage.getState();
    return {
      settings: state.settings,
      rules: state.rules,
      stats: state.stats,
      counts: {
        total: state.rules.length,
        builtin: state.rules.filter((r) => r.source === 'builtin').length,
        user: state.rules.filter((r) => r.source === 'user').length,
        remote: state.rules.filter((r) => r.source === 'remote').length,
        enabled: state.rules.filter((r) => r.enabled !== false).length
      }
    };
  },
  'dyp:save-settings': async (message) => {
    const settings = await storage.saveSettings(message.patch || {});
    await ensureAlarm();
    await notifyTabs();
    return settings;
  },
  'dyp:save-rules': async (message) => {
    const rules = await storage.saveRules(message.rules || []);
    await notifyTabs();
    return { count: rules.length };
  },
  'dyp:delete-rules': async (message) => {
    const ids = new Set(message.ids || []);
    const rules = await storage.getRules();
    const killed = rules.filter((rule) => ids.has(rule.id));
    const next = rules.filter((rule) => !ids.has(rule.id));
    // 记下"用户主动删掉的内置规则"，避免下次同步内置规则时又冒出来
    const builtinIds = killed.filter((rule) => rule.source === 'builtin').map((rule) => rule.id);
    if (builtinIds.length) await storage.addHiddenIds(builtinIds);
    await storage.saveRules(next);
    await notifyTabs();
    return { removed: rules.length - next.length };
  },
  /** 导入规则文本（JSON 字符串或 {rules} 对象），支持 skipDuplicates */
  'dyp:import-rules': async (message) => {
    let payload = message.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch (err) {
        return { ok: false, error: 'JSON 解析失败：' + (err && err.message ? err.message : '') };
      }
    }
    const ruleSet = schema.normalizeRuleSet(payload, {
      defaultSource: message.source || 'user',
      defaultName: message.name
    });
    if (!ruleSet.rules.length) {
      return { ok: false, error: '没有解析出任何规则', warnings: ruleSet.warnings };
    }
    const current = await storage.getRules();
    const merged = schema.mergeRules(current, ruleSet.rules, {
      skipDuplicates: message.skipDuplicates !== false,
      source: message.source || 'user'
    });
    await storage.saveRules(merged.rules);
    await notifyTabs();
    return {
      ok: true,
      added: merged.added,
      updated: merged.updated,
      skipped: merged.skipped,
      total: merged.rules.length,
      warnings: ruleSet.warnings
    };
  },
  /** 从 URL 拉取并导入规则（手动导入或订阅），不写入 remote 订阅状态 */
  'dyp:import-from-url': async (message) => {
    try {
      const subscribed = await remote.fetchSubscription(message.url, { noCache: true });
      const merged = {
        name: message.name || (subscribed.ruleSets[0] && subscribed.ruleSets[0].name),
        rules: remote.mergeRuleSets(subscribed.ruleSets).rules
      };
      const current = await storage.getRules();
      const result = schema.mergeRules(current, merged.rules, {
        skipDuplicates: message.skipDuplicates !== false,
        source: message.source || 'imported'
      });
      await storage.saveRules(result.rules);
      await notifyTabs();
      return {
        ok: true,
        added: result.added,
        skipped: result.skipped,
        total: result.rules.length,
        files: subscribed.ruleSets.length,
        warnings: subscribed.warnings
      };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  },
  'dyp:update-remote': async (message) => {
    const result = await remote.updateFromRemote(message.url);
    if (result.ok) await notifyTabs();
    return result;
  },
  'dyp:get-stats': async () => {
    const stats = await storage.getStats();
    const rules = await storage.getRules();
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    const top = Object.keys(stats.byRule || {})
      .map((id) => {
        const rule = byId.get(id);
        return {
          id: id,
          count: stats.byRule[id],
          name: rule ? rule.name : '(规则已删除)',
          pattern: rule ? rule.pattern : ''
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    return { stats: stats, top: top };
  },
  'dyp:reset-stats': async () => {
    await storage.resetStats();
    return { ok: true };
  },
  'dyp:sync-builtin': async () => {
    const result = await syncBuiltinRules(true);
    return result;
  },
  'dyp:notify-tabs': async () => {
    await notifyTabs();
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || !message.type.startsWith('dyp:')) return false;
  const handler = handlers[message.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message, sender))
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
  return true; // 异步响应
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_BLOCK_SELECTION) return;
  const text = (info.selectionText || '').trim();
  if (!text) return;

  const notify = (message) => {
    if (chrome.notifications) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'douyin-plus',
        message: message
      });
    }
  };

  // 选中文本长度按关键词规则的上限截断，超长时给用户一个提示而不是静默丢弃
  const limit = matcher.MAX_PATTERN_LENGTH;
  const pattern = text.slice(0, limit);

  const rules = await storage.getRules();
  const merged = schema.mergeRules(
    rules,
    [
      {
        name: '来自选中文本：' + pattern.slice(0, 20),
        pattern: pattern,
        type: 'keyword',
        targets: { comment: true, danmaku: true, live: true },
        action: 'hide',
        source: 'user'
      }
    ],
    { skipDuplicates: true, source: 'user' }
  );

  if (!merged.added) {
    notify('这条内容已经在规则里了（跳过重复）');
    return;
  }

  await storage.saveRules(merged.rules);
  await notifyTabs();
  notify(
    '已添加屏蔽规则：' +
      pattern.slice(0, 30) +
      (text.length > limit ? `（选中文本过长，只取前 ${limit} 字）` : '')
  );
});

// 浏览器可能随时回收 worker，这里做一次兜底
ensureAlarm();
