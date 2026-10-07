/**
 * douyin-plus 规则管理页
 */
(function () {
  'use strict';

  const matcher = globalThis.DouyinPlus.matcher;
  const schema = globalThis.DouyinPlus.schema;
  const remoteApi = globalThis.DouyinPlus.remote;

  const $ = (id) => document.getElementById(id);

  const SOURCE_LABEL = { builtin: '内置', user: '自建', remote: '远程', imported: '导入' };
  const TARGET_LABEL = { danmaku: '弹幕', comment: '评论', live: '直播' };

  let state = null;
  let editingId = null;
  let filters = { search: '', source: 'all', target: 'all', state: 'all' };
  /** 表格里勾选的规则 id */
  const selected = new Set();

  // ------------------------------------------------------------ 基础工具

  function send(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(Object.assign({ type: type }, payload || {}), (response) => {
        const err = chrome.runtime.lastError;
        if (err) return resolve({ ok: false, error: err.message });
        resolve(response || { ok: false, error: '无响应' });
      });
    });
  }

  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  let toastTimer = 0;
  function toast(text, kind) {
    const el = $('toast');
    el.textContent = text;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 3200);
  }

  function fmtTime(ts) {
    if (!ts) return '从未';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function targetsText(targets) {
    const on = schema.TARGET_KEYS.filter((key) => targets && targets[key]);
    if (on.length === 3) return '全部';
    if (!on.length) return '无';
    return on.map((key) => TARGET_LABEL[key]).join('/');
  }

  async function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  // ------------------------------------------------------------ 状态刷新

  async function refresh() {
    const response = await send('dyp:get-state');
    if (!response.ok) {
      toast('读取状态失败：' + response.error, 'err');
      return;
    }
    state = response.data;
    renderSettings();
    renderRules();
    renderRemote();
    renderAbout();
  }

  function renderSettings() {
    const settings = state.settings;
    $('enabled').checked = settings.enabled !== false;
    $('enabled-label').textContent = settings.enabled !== false ? '已启用' : '已停用';
    $('remote-url').value = settings.remote.url || '';
    $('remote-enabled').checked = !!settings.remote.enabled;
    $('remote-interval').value = settings.remote.intervalHours || 12;
  }

  function renderAbout() {
    const manifest = chrome.runtime.getManifest();
    $('about-version').textContent =
      `douyin-plus v${manifest.version} · Manifest V${manifest.manifest_version} · 规则结构 schema v${schema.SCHEMA_VERSION}`;
    // 仓库地址以 manifest 的 homepage_url 为准，避免和扩展元数据写两份
    const repo = manifest.homepage_url || 'https://github.com/jeanhua/douyin-plus';
    const repoLink = $('about-repo');
    repoLink.href = repo;
    repoLink.textContent = repo.replace(/^https?:\/\//, '').replace(/\.git$/, '');
    // 默认订阅地址从代码里取，避免文档和实现写两份
    const defaults = globalThis.DouyinPlus.storage || {};
    if ($('default-remote-url')) {
      $('default-remote-url').textContent = defaults.DEFAULT_REMOTE_URL || '(见 storage.js)';
    }
  }

  // ------------------------------------------------------------ 规则表

  function visibleRules() {
    const search = filters.search.toLowerCase();
    return state.rules.filter((rule) => {
      if (filters.source !== 'all' && rule.source !== filters.source) return false;
      if (filters.target !== 'all' && !(rule.targets && rule.targets[filters.target])) return false;
      if (filters.state === 'enabled' && rule.enabled === false) return false;
      if (filters.state === 'disabled' && rule.enabled !== false) return false;
      if (search) {
        const haystack = (rule.name + '\n' + rule.pattern + '\n' + (rule.note || '')).toLowerCase();
        if (haystack.indexOf(search) === -1) return false;
      }
      return true;
    });
  }

  function renderRules() {
    const rules = visibleRules();
    const body = $('rules-body');
    body.innerHTML = '';
    $('rules-empty').hidden = rules.length > 0;
    $('rule-count').textContent =
      `显示 ${rules.length} / 共 ${state.counts.total} 条（内置 ${state.counts.builtin} · 自建 ${state.counts.user} · 远程 ${state.counts.remote} · 启用 ${state.counts.enabled}）`;

    const frag = document.createDocumentFragment();
    for (const rule of rules) {
      const tr = document.createElement('tr');

      const tdOn = document.createElement('td');
      const on = document.createElement('input');
      on.type = 'checkbox';
      on.className = 'row-check';
      on.checked = rule.enabled !== false;
      on.title = '启用 / 停用';
      on.addEventListener('change', () => toggleRule(rule.id, on.checked));
      tdOn.appendChild(on);

      const tdName = document.createElement('td');
      tdName.textContent = rule.name || '(未命名)';
      if (rule.note) tdName.title = rule.note;

      const tdPattern = document.createElement('td');
      tdPattern.className = 'pattern';
      tdPattern.textContent = rule.pattern.length > 120 ? rule.pattern.slice(0, 120) + '…' : rule.pattern;
      tdPattern.title = rule.pattern;

      const tdType = document.createElement('td');
      const typeBadge = document.createElement('span');
      typeBadge.className = 'badge ' + (rule.type === 'regex' ? 'regex' : 'keyword');
      typeBadge.textContent = rule.type === 'regex' ? '正则' : '关键词';
      tdType.appendChild(typeBadge);
      if (rule.caseSensitive) {
        const caseBadge = document.createElement('span');
        caseBadge.className = 'badge';
        caseBadge.textContent = 'Aa';
        tdType.appendChild(document.createTextNode(' '));
        tdType.appendChild(caseBadge);
      }

      const tdTarget = document.createElement('td');
      tdTarget.textContent = targetsText(rule.targets);

      const tdAction = document.createElement('td');
      const actionBadge = document.createElement('span');
      actionBadge.className = 'badge';
      actionBadge.textContent = rule.action === 'blur' ? '模糊' : '隐藏';
      tdAction.appendChild(actionBadge);

      const tdSource = document.createElement('td');
      const sourceBadge = document.createElement('span');
      sourceBadge.className = 'badge ' + (SOURCE_LABEL[rule.source] ? rule.source : 'user');
      sourceBadge.textContent = SOURCE_LABEL[rule.source] || rule.source || '自建';
      tdSource.appendChild(sourceBadge);
      if (rule.remoteName) tdSource.title = rule.remoteName;

      const tdOps = document.createElement('td');
      const edit = document.createElement('button');
      edit.className = 'link';
      edit.type = 'button';
      edit.textContent = '编辑';
      edit.addEventListener('click', () => openEditor(rule.id));
      const del = document.createElement('button');
      del.className = 'link danger';
      del.type = 'button';
      del.textContent = '删除';
      del.style.marginLeft = '10px';
      del.addEventListener('click', () => deleteRules([rule.id], rule.name));
      tdOps.appendChild(edit);
      tdOps.appendChild(del);

      tr.appendChild(tdOn);
      tr.appendChild(tdName);
      tr.appendChild(tdPattern);
      tr.appendChild(tdType);
      tr.appendChild(tdTarget);
      tr.appendChild(tdAction);
      tr.appendChild(tdSource);
      tr.appendChild(tdOps);
      frag.appendChild(tr);
    }
    body.appendChild(frag);
  }

  async function saveAllRules(rules, successText) {
    const response = await send('dyp:save-rules', { rules: rules });
    if (!response.ok) {
      toast('保存失败：' + response.error, 'err');
      return false;
    }
    await refresh();
    if (successText) toast(successText);
    return true;
  }

  async function toggleRule(id, enabled) {
    const rules = state.rules.map((rule) => (rule.id === id ? Object.assign({}, rule, { enabled: enabled }) : rule));
    await saveAllRules(rules, enabled ? '已启用' : '已停用');
  }

  async function deleteRules(ids, label) {
    const names = ids.length === 1 ? `「${label || ''}」` : `${ids.length} 条规则`;
    if (!confirm(`确认删除${names}？删除后可在"导入 / 导出"里重新导入恢复。`)) return;
    const response = await send('dyp:delete-rules', { ids: ids });
    if (!response.ok) return toast('删除失败：' + response.error, 'err');
    selected.clear();
    await refresh();
    toast(`已删除 ${response.data.removed} 条规则`);
  }

  // ------------------------------------------------------------ 筛选与批量

  $('search').addEventListener('input', (e) => {
    filters.search = e.target.value.trim();
    renderRules();
  });
  $('filter-source').addEventListener('change', (e) => {
    filters.source = e.target.value;
    renderRules();
  });
  $('filter-target').addEventListener('change', (e) => {
    filters.target = e.target.value;
    renderRules();
  });
  $('filter-state').addEventListener('change', (e) => {
    filters.state = e.target.value;
    renderRules();
  });

  for (const button of document.querySelectorAll('[data-bulk]')) {
    button.addEventListener('click', async () => {
      const action = button.dataset.bulk;
      const rules = visibleRules();
      if (!rules.length) return toast('当前筛选结果为空', 'err');

      if (action === 'delete') {
        if (!confirm(`确认删除当前筛选出的 ${rules.length} 条规则？内置规则会被记入"不再恢复"名单。`)) return;
        const response = await send('dyp:delete-rules', { ids: rules.map((rule) => rule.id) });
        if (!response.ok) return toast('删除失败：' + response.error, 'err');
        await refresh();
        return toast(`已删除 ${response.data.removed} 条规则`);
      }

      const enabled = action === 'enable';
      const ids = new Set(rules.map((rule) => rule.id));
      const next = state.rules.map((rule) => (ids.has(rule.id) ? Object.assign({}, rule, { enabled: enabled }) : rule));
      await saveAllRules(next, `${enabled ? '启用' : '停用'}了 ${rules.length} 条规则`);
    });
  }

  $('sync-builtin').addEventListener('click', async () => {
    if (!confirm('将从扩展内置文件重新同步内置规则（用户自建规则不受影响，已删除的内置规则不会自动恢复）。是否继续？'))
      return;
    const response = await send('dyp:sync-builtin');
    if (!response.ok || response.data.error) return toast('同步失败：' + (response.error || response.data.error), 'err');
    await refresh();
    toast(`内置规则已同步：新增 ${response.data.added} 条，版本 ${response.data.version}`);
  });

  // ------------------------------------------------------------ 编辑弹窗

  function openEditor(id) {
    editingId = id || null;
    const rule = id ? state.rules.find((item) => item.id === id) : null;
    $('modal-title').textContent = rule ? '编辑规则' : '新建规则';
    $('f-name').value = rule ? rule.name : '';
    $('f-type').value = rule ? rule.type : 'keyword';
    $('f-pattern').value = rule ? rule.pattern : '';
    $('f-case').checked = !!(rule && rule.caseSensitive);
    $('f-enabled').checked = !rule || rule.enabled !== false;
    $('f-action').value = rule ? rule.action : 'hide';
    $('f-note').value = rule ? rule.note || '' : '';
    const targets = (rule && rule.targets) || { danmaku: true, comment: true, live: true };
    $('f-danmaku').checked = !!targets.danmaku;
    $('f-comment').checked = !!targets.comment;
    $('f-live').checked = !!targets.live;
    $('f-meta').textContent = rule
      ? `来源：${SOURCE_LABEL[rule.source] || rule.source} · 创建于 ${fmtTime(rule.createdAt)}`
      : '新规则会标记为"自建"';
    setMsg($('f-pattern-msg'), '');
    $('modal').hidden = false;
    $('f-pattern').focus();
  }

  function closeEditor() {
    $('modal').hidden = true;
    editingId = null;
  }

  $('f-cancel').addEventListener('click', closeEditor);
  $('modal').addEventListener('click', (e) => {
    if (e.target === $('modal')) closeEditor();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('modal').hidden) closeEditor();
  });

  $('f-type').addEventListener('change', () => setMsg($('f-pattern-msg'), ''));
  $('f-pattern').addEventListener('input', () => setMsg($('f-pattern-msg'), ''));

  $('f-save').addEventListener('click', async () => {
    const pattern = $('f-pattern').value.trim();
    const type = $('f-type').value;
    const caseSensitive = $('f-case').checked;

    const error = matcher.validatePattern(pattern, type, caseSensitive);
    if (error) return setMsg($('f-pattern-msg'), error, 'err');

    const targets = {
      danmaku: $('f-danmaku').checked,
      comment: $('f-comment').checked,
      live: $('f-live').checked
    };
    if (!targets.danmaku && !targets.comment && !targets.live) {
      return setMsg($('f-pattern-msg'), '至少选择一个生效场景', 'err');
    }

    const payload = {
      name: $('f-name').value.trim() || (type === 'regex' ? '正则规则' : '关键词规则'),
      pattern: pattern,
      type: type,
      caseSensitive: caseSensitive,
      targets: targets,
      action: $('f-action').value,
      enabled: $('f-enabled').checked,
      note: $('f-note').value.trim()
    };

    let rules;
    if (editingId) {
      rules = state.rules.map((rule) =>
        rule.id === editingId ? Object.assign({}, rule, payload, { updatedAt: Date.now() }) : rule
      );
    } else {
      const created = schema.normalizeRule(Object.assign({ source: 'user' }, payload), { defaultSource: 'user' });
      // 新规则放在最前面，方便立刻确认效果
      rules = [created].concat(state.rules);
    }

    const ok = await saveAllRules(rules, editingId ? '规则已更新' : '规则已创建');
    if (ok) closeEditor();
  });

  $('new-rule').addEventListener('click', () => openEditor(null));

  // ------------------------------------------------------------ 导入

  $('import-file').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    await importText(text, file.name);
  });

  async function importText(text, sourceLabel) {
    const response = await send('dyp:import-rules', {
      payload: text,
      source: $('import-source').value,
      skipDuplicates: $('import-skip-dup').checked
    });
    if (!response.ok || !response.data.ok) {
      const error = response.error || (response.data && response.data.error) || '未知错误';
      setMsg($('import-msg'), '导入失败：' + error, 'err');
      return false;
    }
    const data = response.data;
    const warnings = (data.warnings || []).length ? `，${data.warnings.length} 条被跳过` : '';
    setMsg(
      $('import-msg'),
      `${sourceLabel || '导入'}完成：新增 ${data.added} 条，重复跳过 ${data.skipped} 条，当前共 ${data.total} 条${warnings}`,
      'ok'
    );
    await refresh();
    return true;
  }

  $('import-text-btn').addEventListener('click', async () => {
    const text = $('import-text').value.trim();
    if (!text) return setMsg($('import-msg'), '请先粘贴规则 JSON', 'err');
    if (await importText(text, '文本导入')) $('import-text').value = '';
  });

  $('import-url-btn').addEventListener('click', async () => {
    const url = $('import-url').value.trim();
    if (!url) return setMsg($('import-msg'), '请填写规则地址', 'err');
    const button = $('import-url-btn');
    button.disabled = true;
    setMsg($('import-msg'), '正在拉取…');
    // 自定义域名需要用户授权后才能 fetch（必须在点击的调用栈里发起）
    const allowed = await remoteApi.ensureHostPermission(url);
    if (!allowed) {
      button.disabled = false;
      return setMsg($('import-msg'), '未获得访问该地址的权限，已取消导入', 'err');
    }
    const response = await send('dyp:import-from-url', {
      url: url,
      source: $('import-source').value,
      skipDuplicates: $('import-skip-dup').checked
    });
    button.disabled = false;
    if (!response.ok || !response.data.ok) {
      const error = response.error || (response.data && response.data.error) || '未知错误';
      return setMsg($('import-msg'), '导入失败：' + error, 'err');
    }
    const data = response.data;
    setMsg(
      $('import-msg'),
      `从 ${data.files} 个文件导入完成：新增 ${data.added} 条，重复跳过 ${data.skipped} 条，当前共 ${data.total} 条`,
      'ok'
    );
    await refresh();
  });

  // ------------------------------------------------------------ 导出

  function exportRules() {
    const scope = $('export-scope').value;
    let rules = state.rules;
    if (scope === 'user') rules = rules.filter((rule) => rule.source === 'user' || rule.source === 'imported');
    if (scope === 'enabled') rules = rules.filter((rule) => rule.enabled !== false);
    if (scope === 'builtin') rules = rules.filter((rule) => rule.source === 'builtin');
    if (scope === 'remote') rules = rules.filter((rule) => rule.source === 'remote');
    return rules;
  }

  function renderExportPreview() {
    const rules = exportRules();
    const text = schema.toRuleSet(rules, {
      name: $('export-scope').value === 'all' ? 'douyin-plus 全部规则' : 'douyin-plus 导出规则'
    });
    $('export-preview').value = text;
    return { rules: rules, text: text };
  }

  $('export-scope').addEventListener('change', renderExportPreview);

  $('export-download').addEventListener('click', async () => {
    const { rules, text } = renderExportPreview();
    if (!rules.length) return setMsg($('export-msg'), '所选范围没有规则', 'err');
    const stamp = new Date().toISOString().slice(0, 10);
    await download(`douyin-plus-rules-${stamp}.json`, text);
    setMsg($('export-msg'), `已导出 ${rules.length} 条规则`, 'ok');
  });

  $('export-copy').addEventListener('click', async () => {
    const { rules, text } = renderExportPreview();
    if (!rules.length) return setMsg($('export-msg'), '所选范围没有规则', 'err');
    const ok = await copyText(text);
    setMsg($('export-msg'), ok ? `已复制 ${rules.length} 条规则到剪贴板` : '复制失败，请手动选择文本框内容', ok ? 'ok' : 'err');
  });

  // ------------------------------------------------------------ 远程订阅

  function renderRemote() {
    const remote = state.settings.remote || {};
    const status = $('remote-status');
    const lines = [];
    lines.push(`状态：${remote.enabled ? '自动检查已开启' : '自动检查已关闭'}`);
    lines.push(`上次检查：${fmtTime(remote.lastAt)}`);
    if (remote.lastOk === true) lines.push(`结果：成功，拉到 ${remote.lastCount || 0} 条远程规则（当前生效 ${state.counts.remote} 条）`);
    else if (remote.lastOk === false) lines.push(`结果：失败 —— ${remote.lastError || '未知错误'}`);
    else lines.push('结果：尚未检查过');
    if (remote.lastVersion) lines.push(`远程规则版本：${remote.lastVersion}`);

    status.className = 'status' + (remote.lastOk === true ? ' ok' : remote.lastOk === false ? ' err' : '');
    status.innerHTML = '';
    for (const line of lines) {
      const div = document.createElement('div');
      div.textContent = line;
      status.appendChild(div);
    }
  }

  $('remote-save').addEventListener('click', async () => {
    const patch = {
      remote: {
        url: $('remote-url').value.trim(),
        enabled: $('remote-enabled').checked,
        intervalHours: Math.max(1, Math.min(168, Number($('remote-interval').value) || 12))
      }
    };
    const response = await send('dyp:save-settings', { patch: patch });
    if (!response.ok) return toast('保存失败：' + response.error, 'err');
    await refresh();
    toast('订阅设置已保存');
  });

  $('remote-update').addEventListener('click', async () => {
    const url = $('remote-url').value.trim();
    const button = $('remote-update');
    button.disabled = true;
    $('remote-log').textContent = '正在拉取 ' + (url || '(未填写地址)') + ' …';
    const allowed = await remoteApi.ensureHostPermission(url);
    if (!allowed) {
      button.disabled = false;
      $('remote-log').textContent = '未获得访问该地址的权限。';
      return toast('未获得访问该地址的权限', 'err');
    }
    const response = await send('dyp:update-remote', { url: url });
    button.disabled = false;
    if (!response.ok || !response.data.ok) {
      const error = response.error || (response.data && response.data.error) || '未知错误';
      $('remote-log').textContent = '更新失败：' + error;
      await refresh();
      return toast('更新失败：' + error, 'err');
    }
    const data = response.data;
    const log = [
      `文件：${data.files} 个`,
      `规则：${data.rules} 条`,
      `替换：${data.stats.replaced} 条远程规则，当前生效 ${data.stats.total} 条`
    ];
    if (data.warnings && data.warnings.length) {
      log.push('部分文件失败：');
      for (const warning of data.warnings) log.push('  · ' + warning);
    }
    $('remote-log').textContent = log.join('\n');
    await refresh();
    toast(`远程规则已更新：${data.rules} 条`);
  });

  // ------------------------------------------------------------ 统计

  async function renderStats() {
    const response = await send('dyp:get-stats');
    if (!response.ok) return;
    const stats = response.data.stats;
    const top = response.data.top;

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    $('s-today').textContent = (stats.byDate && stats.byDate[todayKey]) || 0;
    $('s-total').textContent = stats.total || 0;
    $('s-rules').textContent = state.counts.enabled;

    const body = $('stats-body');
    body.innerHTML = '';
    $('stats-empty').hidden = top.length > 0;
    const max = top.reduce((m, item) => Math.max(m, item.count), 0) || 1;
    top.forEach((item, index) => {
      const tr = document.createElement('tr');
      const rank = document.createElement('td');
      rank.textContent = index + 1;
      const name = document.createElement('td');
      name.textContent = item.name;
      const pattern = document.createElement('td');
      pattern.className = 'pattern';
      pattern.textContent = item.pattern;
      pattern.title = item.pattern;
      const count = document.createElement('td');
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.width = Math.round((item.count / max) * 100) + '%';
      const num = document.createElement('span');
      num.textContent = item.count;
      num.style.marginLeft = '8px';
      count.appendChild(bar);
      count.appendChild(num);
      const ops = document.createElement('td');
      if (item.id && state.rules.some((rule) => rule.id === item.id)) {
        const edit = document.createElement('button');
        edit.className = 'link';
        edit.type = 'button';
        edit.textContent = '编辑';
        edit.addEventListener('click', () => {
          switchTab('rules');
          openEditor(item.id);
        });
        ops.appendChild(edit);
      }
      tr.appendChild(rank);
      tr.appendChild(name);
      tr.appendChild(pattern);
      tr.appendChild(count);
      tr.appendChild(ops);
      body.appendChild(tr);
    });
  }

  $('reset-stats').addEventListener('click', async () => {
    if (!confirm('确认清空所有屏蔽统计？规则本身不受影响。')) return;
    await send('dyp:reset-stats');
    await renderStats();
    toast('统计已清空');
  });

  // ------------------------------------------------------------ 顶部开关 & 标签页

  $('enabled').addEventListener('change', async (e) => {
    await send('dyp:save-settings', { patch: { enabled: e.target.checked } });
    await refresh();
    toast(e.target.checked ? '屏蔽已开启' : '屏蔽已暂停');
  });

  function switchTab(name) {
    for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === name);
    for (const panel of document.querySelectorAll('.tab-panel')) {
      panel.classList.toggle('active', panel.id === 'tab-' + name);
    }
    if (name === 'stats') renderStats();
    if (name === 'import') renderExportPreview();
  }

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  }

  refresh();
})();
