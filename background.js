/*
 * ZJUAM-in · MV3 service worker
 *
 * 职责很少：
 *   1. 安装 / 升级时把存储结构初始化成当前 schema；
 *   2. 处理键盘快捷键（默认 Ctrl+Shift+U）：对当前标签页触发「立即填充并登录」，
 *      若该页还没有 content script（例如扩展安装前就打开着的认证页），先动态注入。
 */
importScripts('shared/storage.js');

const NS = globalThis.ZJUAM;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureState() {
  if (!NS) return;
  const state = await NS.loadState();
  await NS.saveState(state);
}

chrome.runtime.onInstalled.addListener(() => {
  ensureState().catch(() => {});
});

let badgeTimer = 0;

function flashBadge(text, color, title) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: color });
    chrome.action.setBadgeText({ text: text });
    chrome.action.setTitle({ title: title });
    if (badgeTimer) clearTimeout(badgeTimer);
    badgeTimer = setTimeout(function () {
      try {
        chrome.action.setBadgeText({ text: '' });
        chrome.action.setTitle({ title: 'ZJUAM-in — 浙大统一身份认证自动登录' });
      } catch (e) {
        /* ignore */
      }
      badgeTimer = 0;
    }, 5000);
  } catch (e) {
    /* ignore */
  }
}

function failureTitle(error) {
  if (error === 'NO_ACCOUNT') return 'ZJUAM-in：还没有配置账户，点击扩展图标添加';
  if (error === 'NO_FORM') return 'ZJUAM-in：当前页没有认证表单，请刷新后重试';
  return 'ZJUAM-in：请先打开浙大统一身份认证登录页';
}

async function fillActiveTab() {
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs && tabs[0];
  } catch (e) {
    flashBadge('!', '#C62828', 'ZJUAM-in：无法读取当前标签页');
    return;
  }
  if (!tab || typeof tab.id !== 'number') {
    flashBadge('!', '#C62828', 'ZJUAM-in：当前没有可用的标签页');
    return;
  }

  const message = { source: 'zjuamin', type: 'FILL_AND_SUBMIT' };
  let response = null;
  try {
    response = await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    /* 页面里还没有 content script，下面尝试动态注入 */
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content/content.css']
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['shared/storage.js', 'content/content.js']
      });
      await sleep(300);
      response = await chrome.tabs.sendMessage(tab.id, message);
    } catch (injectError) {
      flashBadge('!', '#C62828', failureTitle('NO_FORM'));
      return;
    }
  }

  if (response && response.ok) {
    flashBadge(
      '√',
      '#2E7D32',
      'ZJUAM-in：已使用「' +
        (response.accountLabel || '当前账户') +
        '」' +
        (response.submitted ? '填充并提交' : '填充（未自动提交）')
    );
  } else {
    flashBadge('!', '#C62828', failureTitle(response && response.error));
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'fill-now') {
    fillActiveTab().catch(function () {
      flashBadge('!', '#C62828', 'ZJUAM-in：快捷键执行失败');
    });
  }
});
