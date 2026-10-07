/**
 * douyin-plus popup 面板
 * 只负责"看状态 + 快速操作"，重活都交给 background。
 */
(function () {
  'use strict';

  const matcher = globalThis.DouyinPlus.matcher;
  const schema = globalThis.DouyinPlus.schema;
  const remoteApi = globalThis.DouyinPlus.remote;

  const $ = (id) => document.getElementById(id);

  /** 统一的消息封装：background 返回 { ok, data, error } */
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

  function fmtTime(ts) {
    if (!ts) return '从未';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ------------------------------------------------------------ 渲染

  let state = null;

  function render() {
    const settings = state.settings;
    const stats = state.stats || { byDate: {}, total: 0 };

    $('version').textContent = 'v' + chrome.runtime.getManifest().version;
    $('enabled').checked = settings.enabled !== false;
    for (const input of document.querySelectorAll('#targets input[data-target]')) {
      input.checked = settings.targets[input.dataset.target] !== false;
    }
    $('domFilter').checked = settings.domFilter !== false;

    const todayKey = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const key = `${todayKey.getFullYear()}-${pad(todayKey.getMonth() + 1)}-${pad(todayKey.getDate())}`;
    $('today').textContent = stats.byDate[key] || 0;
    $('all').textContent = stats.total || 0;
    $('rules-enabled').textContent = state.counts.enabled;
    $('stats-total').textContent =
      `共 ${state.counts.total} 条规则（内置 ${state.counts.builtin} · 自建 ${state.counts.user} · 远程 ${state.counts.remote}）`;

    $('remote-url').value = settings.remote.url || '';
    $('remote-enabled').checked = !!settings.remote.enabled;
    const remoteState = $('remote-state');
    if (!settings.remote.url) {
      remoteState.textContent = '未配置地址';
      remoteState.className = 'remote-state';
    } else if (settings.remote.lastOk === true) {
      remoteState.textContent = `上次更新 ${fmtTime(settings.remote.lastAt)} · ${settings.remote.lastCount || 0} 条`;
      remoteState.className = 'remote-state ok';
    } else if (settings.remote.lastOk === false) {
      remoteState.textContent = '更新失败：' + (settings.remote.lastError || '未知原因');
      remoteState.className = 'remote-state err';
    } else {
      remoteState.textContent = '尚未更新过';
      remoteState.className = 'remote-state';
    }
  }

  async function refresh() {
    const response = await send('dyp:get-state');
    if (!response.ok) {
      setMsg($('remote-msg'), '读取状态失败：' + (response.error || ''), 'err');
      return;
    }
    state = response.data;
    render();
    renderTop();
  }

  async function renderTop() {
    const response = await send('dyp:get-stats');
    if (!response.ok) return;
    const top = response.data.top || [];
    const list = $('top-list');
    list.innerHTML = '';
    if (!top.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="pat">还没有屏蔽记录</span>';
      list.appendChild(li);
      return;
    }
    for (const item of top) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'pat';
      label.textContent = item.name || item.pattern;
      label.title = item.pattern || '';
      const count = document.createElement('span');
      count.className = 'cnt';
      count.textContent = item.count;
      li.appendChild(label);
      li.appendChild(count);
      list.appendChild(li);
    }
  }

  // ------------------------------------------------------------ 设置项

  $('enabled').addEventListener('change', async (e) => {
    await send('dyp:save-settings', { patch: { enabled: e.target.checked } });
    await refresh();
  });

  for (const input of document.querySelectorAll('#targets input[data-target]')) {
    input.addEventListener('change', async () => {
      const targets = Object.assign({}, state.settings.targets);
      targets[input.dataset.target] = input.checked;
      await send('dyp:save-settings', { patch: { targets: targets } });
      await refresh();
    });
  }

  $('domFilter').addEventListener('change', async (e) => {
    await send('dyp:save-settings', { patch: { domFilter: e.target.checked } });
    await refresh();
  });

  // ------------------------------------------------------------ 快速添加

  async function quickAdd() {
    const raw = $('quick-pattern').value.trim();
    const type = $('quick-type').value;
    if (!raw) return setMsg($('quick-msg'), '请输入要屏蔽的内容', 'err');

    const error = matcher.validatePattern(raw, type, false);
    if (error) return setMsg($('quick-msg'), error, 'err');

    const all = $('quick-all').checked;
    const payload = {
      source: 'user',
      skipDuplicates: true,
      payload: {
        name: (type === 'regex' ? '正则：' : '关键词：') + raw.slice(0, 24),
        rules: [
          {
            pattern: raw,
            type: type,
            action: 'hide',
            targets: all ? 'all' : { comment: true, danmaku: true },
            source: 'user'
          }
        ]
      }
    };
    const response = await send('dyp:import-rules', payload);
    if (!response.ok) return setMsg($('quick-msg'), '添加失败：' + response.error, 'err');
    const data = response.data;
    setMsg(
      $('quick-msg'),
      data.added ? `已添加并生效（新增 ${data.added} 条）` : `规则已存在，跳过（${data.skipped} 条重复）`,
      data.added ? 'ok' : ''
    );
    if (data.added) $('quick-pattern').value = '';
    await refresh();
  }

  $('quick-add').addEventListener('click', quickAdd);
  $('quick-pattern').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') quickAdd();
  });

  // ------------------------------------------------------------ 订阅

  $('remote-save').addEventListener('click', async () => {
    const url = $('remote-url').value.trim();
    const enabled = $('remote-enabled').checked;
    const response = await send('dyp:save-settings', {
      patch: { remote: { url: url, enabled: enabled } }
    });
    if (!response.ok) return setMsg($('remote-msg'), '保存失败：' + response.error, 'err');
    setMsg($('remote-msg'), '订阅设置已保存', 'ok');
    await refresh();
  });

  $('remote-update').addEventListener('click', async () => {
    const button = $('remote-update');
    const url = $('remote-url').value.trim();
    button.disabled = true;
    setMsg($('remote-msg'), '正在拉取规则…');
    const allowed = await remoteApi.ensureHostPermission(url);
    if (!allowed) {
      button.disabled = false;
      return setMsg($('remote-msg'), '未获得访问该地址的权限，已取消', 'err');
    }
    const response = await send('dyp:update-remote', { url: url });
    button.disabled = false;
    if (!response.ok || !response.data.ok) {
      const error = response.error || (response.data && response.data.error) || '未知错误';
      return setMsg($('remote-msg'), '更新失败：' + error, 'err');
    }
    const data = response.data;
    setMsg(
      $('remote-msg'),
      `更新成功：${data.files} 个文件，共 ${data.rules} 条规则` + (data.warnings && data.warnings.length ? `（${data.warnings.length} 个文件失败）` : ''),
      'ok'
    );
    await refresh();
  });

  // ------------------------------------------------------------ 导入导出

  $('export-rules').addEventListener('click', async () => {
    const response = await send('dyp:get-state');
    if (!response.ok) return setMsg($('remote-msg'), '导出失败：' + response.error, 'err');
    const rules = response.data.rules;
    const text = schema.toRuleSet(rules, { name: 'douyin-plus 导出规则' });
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `douyin-plus-rules-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    setMsg($('remote-msg'), `已导出 ${rules.length} 条规则`, 'ok');
  });

  $('import-file').addEventListener('click', () => $('file-input').click());

  $('file-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const response = await send('dyp:import-rules', { payload: text, source: 'user', skipDuplicates: true });
    if (!response.ok || !response.data.ok) {
      return setMsg($('remote-msg'), '导入失败：' + (response.error || (response.data && response.data.error) || ''), 'err');
    }
    const data = response.data;
    setMsg($('remote-msg'), `导入完成：新增 ${data.added} 条，重复跳过 ${data.skipped} 条`, 'ok');
    await refresh();
  });

  // ------------------------------------------------------------ 其他入口

  $('open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  $('open-shortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    $('pages').textContent = tab && /douyin\.com/.test(tab.url || '') ? '当前页面：抖音' : '当前不在抖音页面';
  });

  refresh();
})();
