/*
 * ZJUAM-in · 共享存储层
 *
 * 经典脚本（非 ES module）：content script、popup、options 都通过
 * <script> / manifest 顺序加载，暴露全局 `ZJUAM`。
 *
 * 数据只存放在 chrome.storage.local（本机），不会同步到云端。
 */
(function (global) {
  'use strict';

  const KEY = 'zjuamin.state.v1';
  const MAX_ACCOUNTS = 20;

  const DEFAULT_SETTINGS = Object.freeze({
    autoFill: true, // 打开认证页就填账号密码
    autoSubmit: true, // 填充后自动点「登录」
    rememberMe: false, // 顺带勾选页面上的「记住我」
    showToast: true, // 在认证页显示轻提示
    submitDelayMs: 150, // 填充后稍等页面脚本就绪再点登录（之前 350，再叠加验证码轮询导致明显等待）
    minSubmitIntervalMs: 15000, // 同一次页面刷新周期内的防重试间隔
    maxAutoAttempts: 3 // 一个标签页会话里最多自动提交几次
  });

  function emptyState() {
    return {
      schemaVersion: 1,
      accounts: [],
      activeAccountId: '',
      settings: Object.assign({}, DEFAULT_SETTINGS)
    };
  }

  function makeId() {
    try {
      if (global.crypto && typeof global.crypto.randomUUID === 'function') {
        return global.crypto.randomUUID();
      }
    } catch (e) {
      /* ignore */
    }
    return 'acc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function normalizeAccount(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const username = typeof raw.username === 'string' ? raw.username.trim() : '';
    const password = typeof raw.password === 'string' ? raw.password : '';
    if (!username || !password) return null;
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 40) : username;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : makeId(),
      label,
      username: username.slice(0, 120),
      password,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now()
    };
  }

  function normalize(raw) {
    const state = emptyState();
    if (!raw || typeof raw !== 'object') return state;

    const seenIds = new Set();
    const seenUsers = new Set();
    if (Array.isArray(raw.accounts)) {
      for (const item of raw.accounts) {
        const account = normalizeAccount(item);
        if (!account || seenIds.has(account.id)) continue;
        const userKey = account.username.toLowerCase();
        if (seenUsers.has(userKey)) continue;
        seenIds.add(account.id);
        seenUsers.add(userKey);
        state.accounts.push(account);
        if (state.accounts.length >= MAX_ACCOUNTS) break;
      }
    }

    if (raw.settings && typeof raw.settings === 'object') {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        const fallback = DEFAULT_SETTINGS[key];
        const value = raw.settings[key];
        if (typeof fallback === 'boolean') {
          if (typeof value === 'boolean') state.settings[key] = value;
        } else if (typeof fallback === 'number') {
          if (Number.isFinite(value) && value >= 0) {
            // 1.0.2 之前默认值是 350ms：老用户没有设置入口，自动迁移到更快的新默认值。
            state.settings[key] = key === 'submitDelayMs' && value === 350 ? fallback : value;
          }
        }
      }
    }

    const active = typeof raw.activeAccountId === 'string' ? raw.activeAccountId : '';
    state.activeAccountId = state.accounts.some((a) => a.id === active)
      ? active
      : state.accounts.length
        ? state.accounts[0].id
        : '';
    return state;
  }

  async function loadState() {
    if (!global.chrome || !global.chrome.storage || !global.chrome.storage.local) {
      return emptyState();
    }
    const stored = await chrome.storage.local.get(KEY);
    return normalize(stored && stored[KEY]);
  }

  async function saveState(state) {
    const normalized = normalize(state);
    if (!global.chrome || !global.chrome.storage || !global.chrome.storage.local) {
      return normalized;
    }
    await chrome.storage.local.set({ [KEY]: normalized });
    return normalized;
  }

  function getActiveAccount(state) {
    const normalized = normalize(state);
    if (!normalized.accounts.length) return null;
    return normalized.accounts.find((a) => a.id === normalized.activeAccountId) || normalized.accounts[0];
  }

  async function updateSettings(patch) {
    const state = await loadState();
    if (patch && typeof patch === 'object') Object.assign(state.settings, patch);
    return saveState(state);
  }

  /** 订阅存储变化；返回取消订阅函数。 */
  function subscribe(callback) {
    if (!global.chrome || !global.chrome.storage || !global.chrome.storage.onChanged) {
      return function () {};
    }
    const listener = function (changes, areaName) {
      if (areaName !== 'local' || !changes[KEY]) return;
      callback(normalize(changes[KEY].newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return function () {
      chrome.storage.onChanged.removeListener(listener);
    };
  }

  global.ZJUAM = {
    KEY,
    MAX_ACCOUNTS,
    DEFAULT_SETTINGS,
    emptyState,
    makeId,
    normalize,
    normalizeAccount,
    loadState,
    saveState,
    getActiveAccount,
    updateSettings,
    subscribe
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
