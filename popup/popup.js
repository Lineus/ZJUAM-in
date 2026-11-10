/* ZJUAMin · popup */
(function () {
  'use strict';

  const NS = globalThis.ZJUAM;
  const $ = function (id) {
    return document.getElementById(id);
  };
  const els = {
    connBadge: $('connBadge'),
    connText: $('connText'),
    accountSelect: $('accountSelect'),
    accountHint: $('accountHint'),
    autoFill: $('autoFill'),
    autoSubmit: $('autoSubmit'),
    fillNow: $('fillNow'),
    statusLine: $('statusLine'),
    openOptions: $('openOptions'),
    versionText: $('versionText')
  };

  let state = NS.emptyState();
  let activeTab = null;
  let lastPing = null;
  let busy = false;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        reject(new Error('TIMEOUT'));
      }, ms);
      promise.then(
        function (value) {
          clearTimeout(timer);
          resolve(value);
        },
        function (error) {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  function setStatus(text, tone) {
    els.statusLine.textContent = text || '';
    els.statusLine.className = 'status' + (tone ? ' status--' + tone : '');
  }

  function setConn(tone, text) {
    els.connBadge.className = 'conn conn--' + tone;
    els.connText.textContent = text;
  }

  function render() {
    const active = NS.getActiveAccount(state);
    const hasAccounts = state.accounts.length > 0;

    els.accountSelect.innerHTML = '';
    if (!hasAccounts) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '未配置账户';
      els.accountSelect.appendChild(option);
      els.accountSelect.disabled = true;
    } else {
      els.accountSelect.disabled = false;
      state.accounts.forEach(function (account) {
        const option = document.createElement('option');
        option.value = account.id;
        option.textContent = account.label + ' · ' + account.username;
        els.accountSelect.appendChild(option);
      });
      els.accountSelect.value = state.activeAccountId;
    }

    if (active) {
      els.accountHint.textContent = '学号 / 工号 ' + active.username + '，密码已保存在本机。';
      els.accountHint.classList.remove('hint--warn');
    } else {
      els.accountHint.textContent = '还没有账户，点击右上角「管理账户」添加第一个。';
      els.accountHint.classList.add('hint--warn');
    }

    els.autoFill.checked = !!state.settings.autoFill;
    els.autoSubmit.checked = !!state.settings.autoSubmit;

    els.fillNow.textContent = hasAccounts ? '立即填充并登录' : '添加第一个账户';
    updateFillButton();
  }

  function updateFillButton() {
    if (!state.accounts.length) {
      els.fillNow.disabled = false;
      return;
    }
    if (!lastPing) {
      els.fillNow.disabled = true;
      return;
    }
    els.fillNow.disabled = !lastPing.hasForm;
  }

  async function save() {
    state = await NS.saveState(state);
  }

  // 保存前重新读一次存储，只改自己关心的字段，避免和设置页互相覆盖。
  async function patchState(patch) {
    const fresh = await NS.loadState();
    if (typeof patch === 'function') patch(fresh);
    state = await NS.saveState(fresh);
    render();
  }

  async function notifyTab(message) {
    if (!activeTab || typeof activeTab.id !== 'number') return null;
    try {
      return await withTimeout(chrome.tabs.sendMessage(activeTab.id, message), 4000);
    } catch (e) {
      return null;
    }
  }

  async function getActiveTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs[0] ? tabs[0] : null;
    } catch (e) {
      return null;
    }
  }

  async function pingTab(tab) {
    if (!tab || typeof tab.id !== 'number') return null;
    try {
      return await withTimeout(
        chrome.tabs.sendMessage(tab.id, { source: 'zjuamin', type: 'PING' }),
        2500
      );
    } catch (e) {
      return null;
    }
  }

  async function ensureInjected(tab) {
    if (!tab || typeof tab.id !== 'number') return null;
    if (!tab.url || tab.url.indexOf('https://zjuam.zju.edu.cn/') !== 0) return null;
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content/content.css']
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['shared/storage.js', 'content/content.js']
      });
    } catch (e) {
      return null;
    }
    for (let i = 0; i < 12; i += 1) {
      await sleep(150);
      const pong = await pingTab(tab);
      if (pong) return pong;
    }
    return null;
  }

  async function refreshConnection() {
    activeTab = await getActiveTab();
    setConn('checking', '检测中');
    lastPing = await pingTab(activeTab);
    if (!lastPing) lastPing = await ensureInjected(activeTab);

    if (lastPing && lastPing.hasForm) {
      setConn('ok', '已识别认证页');
      setStatus('页面已就绪，打开认证页会自动登录。', 'muted');
    } else if (lastPing) {
      setConn('warn', '已连接 · 非登录页');
      setStatus('当前页不是统一身份认证登录表单。', 'warn');
    } else {
      setConn('off', '未检测到认证页');
      setStatus('打开 https://zjuam.zju.edu.cn/ 后会自动登录。', 'muted');
    }
    updateFillButton();
  }

  function openOptions() {
    try {
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage(function () {
          void chrome.runtime.lastError;
        });
        return;
      }
    } catch (e) {
      /* fallback below */
    }
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
  }

  async function handleFillNow() {
    if (busy) return;
    if (!state.accounts.length) {
      openOptions();
      return;
    }

    busy = true;
    els.fillNow.disabled = true;
    setStatus('正在查找认证表单…', 'muted');

    try {
      activeTab = await getActiveTab();
      let pong = await pingTab(activeTab);
      if (!pong) pong = await ensureInjected(activeTab);
      if (!pong) {
        setConn('off', '未检测到认证页');
        setStatus('当前标签页不是浙大统一身份认证页面。', 'warn');
        return;
      }
      if (!pong.hasForm) {
        setStatus('当前页没有找到登录表单，请刷新认证页后重试。', 'warn');
        return;
      }

      lastPing = pong;
      setConn('ok', '已识别认证页');
      const result = await withTimeout(
        chrome.tabs.sendMessage(activeTab.id, { source: 'zjuamin', type: 'FILL_AND_SUBMIT' }),
        15000
      );
      if (result && result.ok) {
        if (result.submitted) {
          setStatus('已用「' + result.accountLabel + '」提交登录。', 'ok');
        } else {
          setStatus('账号密码已填好，请手动完成剩余步骤。', 'warn');
        }
      } else {
        setStatus('操作失败：' + ((result && result.error) || '未知错误'), 'warn');
      }
    } catch (e) {
      setStatus('操作超时，请刷新认证页后重试。', 'warn');
    } finally {
      busy = false;
      updateFillButton();
    }
  }

  els.accountSelect.addEventListener('change', async function () {
    if (!state.accounts.length) return;
    const wanted = els.accountSelect.value;
    await patchState(function (fresh) {
      if (
        fresh.accounts.some(function (item) {
          return item.id === wanted;
        })
      ) {
        fresh.activeAccountId = wanted;
      }
    });
    const active = NS.getActiveAccount(state);
    setStatus(active ? '已切换到「' + active.label + '」。' : '', 'ok');
    await notifyTab({ source: 'zjuamin', type: 'STATE_CHANGED' });
  });

  els.autoFill.addEventListener('change', async function () {
    const wanted = els.autoFill.checked;
    await patchState(function (fresh) {
      fresh.settings.autoFill = wanted;
    });
    setStatus(els.autoFill.checked ? '已开启自动填充。' : '已关闭自动填充。', 'muted');
    await notifyTab({ source: 'zjuamin', type: 'STATE_CHANGED' });
  });

  els.autoSubmit.addEventListener('change', async function () {
    const wanted = els.autoSubmit.checked;
    await patchState(function (fresh) {
      fresh.settings.autoSubmit = wanted;
    });
    setStatus(els.autoSubmit.checked ? '已开启自动提交。' : '已关闭自动提交。', 'muted');
    await notifyTab({ source: 'zjuamin', type: 'STATE_CHANGED' });
  });

  els.fillNow.addEventListener('click', handleFillNow);
  els.openOptions.addEventListener('click', openOptions);

  (async function main() {
    try {
      els.versionText.textContent = 'v' + chrome.runtime.getManifest().version;
    } catch (e) {
      /* ignore */
    }
    state = await NS.loadState();
    render();
    NS.subscribe(function (fresh) {
      state = fresh;
      render();
    });
    await refreshConnection();
  })();
})();
