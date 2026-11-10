/*
 * ZJUAMin · 设置页
 *
 * 账户增删改查、当前账户切换、导入导出与自动登录开关。
 * 所有数据都保存在 chrome.storage.local（仅本机）。
 */
(function () {
  'use strict';

  const NS = window.ZJUAM;
  if (!NS) return;

  const els = {
    versionText: document.getElementById('versionText'),
    accountList: document.getElementById('accountList'),
    accountCount: document.getElementById('accountCount'),
    editorTitle: document.getElementById('editorTitle'),
    cancelEdit: document.getElementById('cancelEdit'),
    accountForm: document.getElementById('accountForm'),
    fieldLabel: document.getElementById('fieldLabel'),
    fieldUsername: document.getElementById('fieldUsername'),
    fieldPassword: document.getElementById('fieldPassword'),
    togglePassword: document.getElementById('togglePassword'),
    fieldMakeActive: document.getElementById('fieldMakeActive'),
    formError: document.getElementById('formError'),
    saveAccountBtn: document.getElementById('saveAccountBtn'),
    resetFormBtn: document.getElementById('resetFormBtn'),
    setAutoFill: document.getElementById('setAutoFill'),
    setAutoSubmit: document.getElementById('setAutoSubmit'),
    setRememberMe: document.getElementById('setRememberMe'),
    setShowToast: document.getElementById('setShowToast'),
    exportBtn: document.getElementById('exportBtn'),
    importBtn: document.getElementById('importBtn'),
    importFile: document.getElementById('importFile'),
    clearBtn: document.getElementById('clearBtn'),
    toast: document.getElementById('toast')
  };

  const SETTING_INPUTS = [
    ['setAutoFill', 'autoFill'],
    ['setAutoSubmit', 'autoSubmit'],
    ['setRememberMe', 'rememberMe'],
    ['setShowToast', 'showToast']
  ];

  let state = NS.emptyState();
  let editingId = null;
  let toastTimer = 0;

  /* ───────── 小工具 ───────── */

  function showToast(message, tone) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.className = 'toast show' + (tone ? ' ' + tone : '');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(
      () => {
        els.toast.className = 'toast';
      },
      tone === 'error' ? 4200 : 2800
    );
  }

  function setFormError(message) {
    els.formError.textContent = message || '';
  }

  function clearFormError() {
    setFormError('');
  }

  function accountById(id) {
    return state.accounts.find((account) => account.id === id) || null;
  }

  function activeAccount() {
    return state.accounts.find((account) => account.id === state.activeAccountId) || null;
  }

  /* ───────── 渲染 ───────── */

  function render() {
    renderAccounts();
    renderCount();
    syncSettings();
  }

  function renderCount() {
    els.accountCount.textContent = state.accounts.length ? state.accounts.length + ' 个' : '';
  }

  function renderAccounts() {
    els.accountList.textContent = '';

    if (!state.accounts.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML =
        '<div class="empty-icon">＋</div>' +
        '<p>还没有保存任何账户</p>' +
        '<p class="muted">在右侧填写学号和密码，保存后打开认证页即可自动登录。</p>';
      els.accountList.appendChild(empty);
      return;
    }

    for (const account of state.accounts) {
      const isActive = account.id === state.activeAccountId;

      const item = document.createElement('div');
      item.className = 'account-item' + (isActive ? ' is-active' : '');

      const avatar = document.createElement('div');
      avatar.className = 'account-avatar';
      avatar.textContent = (account.label || account.username).trim().charAt(0).toUpperCase();

      const info = document.createElement('div');
      info.className = 'account-info';

      const name = document.createElement('div');
      name.className = 'account-name';
      name.textContent = account.label;
      if (isActive) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = '当前';
        name.appendChild(chip);
      }

      const meta = document.createElement('div');
      meta.className = 'account-meta';
      meta.textContent = account.username + ' · 密码已保存';

      info.appendChild(name);
      info.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'account-actions';

      if (!isActive) {
        actions.appendChild(makeMiniButton('active', account.id, '设为当前'));
      }
      actions.appendChild(makeMiniButton('edit', account.id, '编辑'));
      actions.appendChild(makeMiniButton('delete', account.id, '删除', true));

      item.appendChild(avatar);
      item.appendChild(info);
      item.appendChild(actions);
      els.accountList.appendChild(item);
    }
  }

  function makeMiniButton(act, id, text, danger) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mini' + (danger ? ' danger' : '');
    button.dataset.act = act;
    button.dataset.id = id;
    button.textContent = text;
    return button;
  }

  function syncSettings() {
    for (const [id, key] of SETTING_INPUTS) {
      if (els[id]) els[id].checked = Boolean(state.settings[key]);
    }
  }

  /* ───────── 表单 / 编辑 ───────── */

  function resetEditor() {
    editingId = null;
    els.accountForm.reset();
    els.editorTitle.textContent = '添加账户';
    els.cancelEdit.hidden = true;
    els.saveAccountBtn.textContent = '保存账户';
    els.fieldMakeActive.checked = state.accounts.length === 0;
    clearFormError();
    if (els.fieldPassword.type !== 'password') {
      els.fieldPassword.type = 'password';
      els.togglePassword.textContent = '显示';
    }
  }

  function startEdit(id) {
    const account = accountById(id);
    if (!account) {
      showToast('这个账户已不存在。', 'warn');
      resetEditor();
      return;
    }
    editingId = id;
    els.editorTitle.textContent = '编辑账户';
    els.cancelEdit.hidden = false;
    els.saveAccountBtn.textContent = '保存修改';
    els.fieldLabel.value = account.label;
    els.fieldUsername.value = account.username;
    els.fieldPassword.value = account.password;
    els.fieldMakeActive.checked = account.id === state.activeAccountId;
    clearFormError();
    if (els.fieldPassword.type !== 'password') {
      els.fieldPassword.type = 'password';
      els.togglePassword.textContent = '显示';
    }
    els.fieldUsername.focus();
    els.accountForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    clearFormError();

    const username = els.fieldUsername.value.trim();
    const password = els.fieldPassword.value;
    const rawLabel = els.fieldLabel.value.trim();

    if (!username) {
      setFormError('请填写学号 / 工号。');
      els.fieldUsername.focus();
      return;
    }
    if (/\s/.test(username)) {
      setFormError('学号 / 工号中不能包含空格。');
      els.fieldUsername.focus();
      return;
    }
    if (!password) {
      setFormError('请填写统一身份认证密码。');
      els.fieldPassword.focus();
      return;
    }

    const duplicate = state.accounts.find(
      (account) => account.id !== editingId && account.username.toLowerCase() === username.toLowerCase()
    );
    if (duplicate) {
      setFormError('该学号 / 工号已存在账户「' + duplicate.label + '」，请直接编辑它。');
      return;
    }

    const wasEditing = Boolean(editingId);
    if (wasEditing && !accountById(editingId)) {
      resetEditor();
      setFormError('这个账户已不存在，请重新添加。');
      return;
    }
    if (!wasEditing && state.accounts.length >= NS.MAX_ACCOUNTS) {
      setFormError('最多只能保存 ' + NS.MAX_ACCOUNTS + ' 个账户。');
      return;
    }

    const now = Date.now();
    let savedId;

    if (wasEditing) {
      const account = accountById(editingId);
      account.label = rawLabel || username;
      account.username = username;
      account.password = password;
      account.updatedAt = now;
      savedId = account.id;
    } else {
      const account = {
        id: NS.makeId(),
        label: rawLabel || username,
        username,
        password,
        createdAt: now,
        updatedAt: now
      };
      state.accounts.push(account);
      savedId = account.id;
    }

    if (els.fieldMakeActive.checked) state.activeAccountId = savedId;
    if (!state.accounts.some((account) => account.id === state.activeAccountId)) {
      state.activeAccountId = state.accounts.length ? state.accounts[0].id : '';
    }

    try {
      state = await NS.saveState(state);
    } catch (error) {
      setFormError('保存失败：' + (error && error.message ? error.message : '未知错误'));
      return;
    }

    const saved = accountById(savedId);
    const label = saved ? saved.label : username;
    render();
    resetEditor();
    showToast(wasEditing ? '已保存对账户「' + label + '」的修改。' : '已添加账户「' + label + '」。', 'ok');
  }

  /* ───────── 账户操作 ───────── */

  async function setActiveAccount(id) {
    const account = accountById(id);
    if (!account) return;
    state.activeAccountId = id;
    try {
      state = await NS.saveState(state);
    } catch (error) {
      showToast('切换账户失败：' + (error && error.message ? error.message : '未知错误'), 'error');
      return;
    }
    render();
    if (editingId === id) els.fieldMakeActive.checked = true;
    showToast('已切换到账户「' + account.label + '」。', 'ok');
  }

  async function deleteAccount(id) {
    const account = accountById(id);
    if (!account) return;
    const confirmed = window.confirm('确定删除账户「' + account.label + '」（' + account.username + '）吗？');
    if (!confirmed) return;

    state.accounts = state.accounts.filter((item) => item.id !== id);
    if (state.activeAccountId === id) {
      state.activeAccountId = state.accounts.length ? state.accounts[0].id : '';
    }
    try {
      state = await NS.saveState(state);
    } catch (error) {
      showToast('删除失败：' + (error && error.message ? error.message : '未知错误'), 'error');
      return;
    }
    if (editingId === id) resetEditor();
    render();
    showToast('已删除账户「' + account.label + '」。', 'warn');
  }

  /* ───────── 导入 / 导出 / 清空 ───────── */

  function exportAccounts() {
    if (!state.accounts.length) {
      showToast('还没有可导出的账户。', 'warn');
      return;
    }
    const payload = {
      app: 'zjuamin',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      accounts: state.accounts.map((account) => ({
        label: account.label,
        username: account.username,
        password: account.password
      }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date();
    const stamp =
      String(date.getFullYear()) +
      String(date.getMonth() + 1).padStart(2, '0') +
      String(date.getDate()).padStart(2, '0');
    link.href = url;
    link.download = 'zjuamin-accounts-' + stamp + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast('已导出。文件包含明文密码，请妥善保管。', 'warn');
  }

  async function handleImport() {
    const file = els.importFile.files && els.importFile.files[0];
    els.importFile.value = '';
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      showToast('文件过大，请确认选择的是本扩展导出的 JSON 文件。', 'error');
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      showToast('导入失败：文件不是有效的 JSON。', 'error');
      return;
    }

    const rawAccounts = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.accounts) ? parsed.accounts : null;
    if (!rawAccounts) {
      showToast('导入失败：文件里没有账户列表。', 'error');
      return;
    }

    let added = 0;
    let skipped = 0;
    let invalid = 0;
    for (const item of rawAccounts) {
      const account = NS.normalizeAccount(item);
      if (!account) {
        invalid += 1;
        continue;
      }
      const duplicated = state.accounts.some(
        (existing) => existing.username.toLowerCase() === account.username.toLowerCase()
      );
      if (duplicated || state.accounts.length >= NS.MAX_ACCOUNTS) {
        skipped += 1;
        continue;
      }
      const now = Date.now();
      state.accounts.push({
        id: NS.makeId(),
        label: account.label,
        username: account.username,
        password: account.password,
        createdAt: now,
        updatedAt: now
      });
      added += 1;
    }

    if (!state.accounts.some((account) => account.id === state.activeAccountId)) {
      state.activeAccountId = state.accounts.length ? state.accounts[0].id : '';
    }

    try {
      state = await NS.saveState(state);
    } catch (error) {
      showToast('导入失败：' + (error && error.message ? error.message : '未知错误'), 'error');
      return;
    }

    render();
    const details = [];
    if (added) details.push('新增 ' + added + ' 个');
    if (skipped) details.push('跳过 ' + skipped + ' 个重复或超额');
    if (invalid) details.push('忽略 ' + invalid + ' 条无效记录');
    showToast(
      added ? '导入完成：' + details.join('，') + '。' : '没有新增账户' + (details.length ? '（' + details.join('，') + '）' : '') + '。',
      added ? 'ok' : 'warn'
    );
  }

  async function clearAll() {
    if (!state.accounts.length) {
      showToast('当前没有可清空的数据。', 'warn');
      return;
    }
    const confirmed = window.confirm(
      '确定清空全部数据吗？将删除 ' + state.accounts.length + ' 个账户和所有设置，且无法恢复。'
    );
    if (!confirmed) return;

    const cleared = NS.emptyState();
    try {
      state = await NS.saveState(cleared);
    } catch (error) {
      showToast('清空失败：' + (error && error.message ? error.message : '未知错误'), 'error');
      return;
    }
    resetEditor();
    render();
    showToast('已清空全部数据。', 'warn');
  }

  /* ───────── 事件绑定 ───────── */

  function bindEvents() {
    els.accountForm.addEventListener('submit', handleSubmit);
    els.resetFormBtn.addEventListener('click', resetEditor);
    els.cancelEdit.addEventListener('click', resetEditor);

    els.togglePassword.addEventListener('click', () => {
      const showing = els.fieldPassword.type === 'text';
      els.fieldPassword.type = showing ? 'password' : 'text';
      els.togglePassword.textContent = showing ? '显示' : '隐藏';
    });

    els.fieldUsername.addEventListener('input', clearFormError);
    els.fieldPassword.addEventListener('input', clearFormError);

    els.accountList.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-act]');
      if (!button) return;
      const id = button.dataset.id;
      if (button.dataset.act === 'edit') startEdit(id);
      else if (button.dataset.act === 'delete') deleteAccount(id);
      else if (button.dataset.act === 'active') setActiveAccount(id);
    });

    for (const [id, key] of SETTING_INPUTS) {
      const input = els[id];
      input.addEventListener('change', async () => {
        state.settings[key] = input.checked;
        try {
          state = await NS.saveState(state);
        } catch (error) {
          input.checked = !input.checked;
          state.settings[key] = input.checked;
          showToast('设置保存失败：' + (error && error.message ? error.message : '未知错误'), 'error');
        }
      });
    }

    els.exportBtn.addEventListener('click', exportAccounts);
    els.importBtn.addEventListener('click', () => els.importFile.click());
    els.importFile.addEventListener('change', handleImport);
    els.clearBtn.addEventListener('click', clearAll);
  }

  /* ───────── 启动 ───────── */

  async function init() {
    try {
      els.versionText.textContent = 'v' + chrome.runtime.getManifest().version;
    } catch (error) {
      els.versionText.textContent = 'v1.0.0';
    }

    try {
      state = await NS.loadState();
    } catch (error) {
      state = NS.emptyState();
    }

    bindEvents();
    render();
    resetEditor();
    els.fieldMakeActive.checked = state.accounts.length === 0;

    NS.subscribe((next) => {
      state = next;
      renderAccounts();
      renderCount();
      syncSettings();
      if (editingId && !accountById(editingId)) resetEditor();
    });
  }

  init();
})();
