/*
 * ZJUAM-in · content script
 *
 * 仅在 https://zjuam.zju.edu.cn/ 下由 manifest 注入。职责：
 *   1. 识别统一身份认证登录表单；
 *   2. 用当前选中的账户填入学号 / 密码；
 *   3. （可选）自动点击页面上的「登录」按钮，由页面自身的 login.js 完成
 *      RSA 加密与表单提交 —— 这样加密算法随学校页面更新，不重复实现；
 *   4. 防止死循环：密码错误 / 验证码 / 刚提交过 时不做自动提交。
 */
(function () {
  'use strict';

  const NS = globalThis.ZJUAM;
  if (!NS) return;
  if (globalThis.__ZJUAMIN_CONTENT_LOADED__) return;
  globalThis.__ZJUAMIN_CONTENT_LOADED__ = true;

  const ORIGIN = 'https://zjuam.zju.edu.cn';
  const GUARD_KEY = 'zjuamin.guard.v1';
  const FAILURE_KEY = 'zjuamin.failure.v1';
  const FAILURE_TTL_MS = 30 * 60 * 1000;
  const TOAST_ID = 'zjuamin-toast';
  const FORM_WAIT_MS = 15000;

  const SELECTORS = {
    username: '#username, input[name="username"]',
    password: '#password, input[name="password"]',
    submit: '#dl, button.login-btn, form#fm1 button[type="submit"], form#fm1 input[type="submit"]',
    form: '#fm1, form[action*="/cas/login"]',
    captchaBox: '#kaptcha',
    error: '#errormsg, #login_container .error',
    remember: '#rember'
  };

  let account = null;
  let settings = Object.assign({}, NS.DEFAULT_SETTINGS);
  let lastClickAt = 0;
  let toastEl = null;
  let toastTimer = 0;
  let ready = false;

  let resolveReady;
  const readyPromise = new Promise(function (resolve) {
    resolveReady = resolve;
  });

  function markReady() {
    if (ready) return;
    ready = true;
    resolveReady();
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.source !== 'zjuamin') return false;
    if (sender && sender.id && sender.id !== chrome.runtime.id) return false;
    handleMessage(message)
      .then(function (result) {
        sendResponse(result);
      })
      .catch(function (error) {
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  });

  init().catch(function () {
    markReady();
  });

  // 设置页 / 弹窗修改账户或开关时，已打开的认证页也立即跟上（不必刷新）。
  try {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'local' || !changes || !changes[NS.KEY]) return;
      reloadState()
        .then(function () {
          if (!settings.autoFill || !account) return;
          const info = readForm();
          if (info) fillForm(account, false);
        })
        .catch(function () {
          /* ignore */
        });
    });
  } catch (e) {
    /* ignore */
  }

  /* ───────────────────────────── 初始化 ───────────────────────────── */

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function reloadState() {
    const state = await NS.loadState();
    account = NS.getActiveAccount(state);
    settings = Object.assign({}, NS.DEFAULT_SETTINGS, state.settings || {});
  }

  async function init() {
    try {
      if (location.origin !== ORIGIN) return;
      await reloadState();

      const info = await waitForLoginForm(FORM_WAIT_MS);
      if (!info) return;
      if (!settings.autoFill) return;
      if (!account) {
        toast('尚未配置 ZJUAM-in 账户：点击浏览器工具栏的扩展图标添加', 'warn', 7000);
        return;
      }

      // 关键：真实页面在 #username 的 input 事件里会清空 #errormsg，
      // 所以必须在填表之前把「上一次登录失败」的证据读出来。
      const pendingError = readServerError();
      fillForm(account, false);
      toast('已填充账户「' + account.label + '」', 'info');

      if (settings.autoSubmit) {
        await autoSubmit(info, false, pendingError);
      }
    } finally {
      markReady();
    }
  }

  /* ───────────────────────────── 页面识别 ───────────────────────────── */

  function readForm() {
    if (location.origin !== ORIGIN) return null;
    const username = document.querySelector(SELECTORS.username);
    const password = document.querySelector(SELECTORS.password);
    if (!username || !password) return null;
    const form = document.querySelector(SELECTORS.form) || username.form || password.form || null;
    const submit = document.querySelector(SELECTORS.submit);
    if (!form && !submit) return null;
    return { username: username, password: password, form: form, submit: submit };
  }

  function waitForLoginForm(timeoutMs) {
    return new Promise(function (resolve) {
      const immediate = readForm();
      if (immediate) {
        resolve(immediate);
        return;
      }
      let settled = false;
      let timer = 0;
      const observer = new MutationObserver(function () {
        const found = readForm();
        if (found) finish(found);
      });

      function finish(value) {
        if (settled) return;
        settled = true;
        observer.disconnect();
        if (timer) clearTimeout(timer);
        resolve(value);
      }

      observer.observe(document.documentElement, { childList: true, subtree: true });
      timer = setTimeout(function () {
        finish(null);
      }, timeoutMs);
    });
  }

  function isCaptchaVisible() {
    const box = document.querySelector(SELECTORS.captchaBox);
    if (!box) return false;
    try {
      const style = getComputedStyle(box);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
    } catch (e) {
      /* ignore */
    }
    return true;
  }

  // 页面在 jQuery ready 后才异步请求 v2/getKaptchaStatus 决定验证码显隐，
  // 提交前给它一点时间，避免抢在「验证码即将出现」之前点提交。
  function waitForCaptchaState(timeoutMs) {
    return new Promise(function (resolve) {
      const deadline = Date.now() + (timeoutMs || 0);
      function check() {
        if (isCaptchaVisible()) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(check, 150);
      }
      check();
    });
  }

  function readServerError() {
    const nodes = document.querySelectorAll(SELECTORS.error);
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 120);
    }
    return '';
  }

  /* ───────────────────────────── 填表 ───────────────────────────── */

  function setInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function highlight(input) {
    try {
      input.classList.remove('zjuamin-autofilled');
      // 强制重启动画
      void input.offsetWidth;
      input.classList.add('zjuamin-autofilled');
      setTimeout(function () {
        input.classList.remove('zjuamin-autofilled');
      }, 1600);
    } catch (e) {
      /* ignore */
    }
  }

  function fillForm(acc, focus) {
    const info = readForm();
    if (!info || !acc) return false;
    setInputValue(info.username, acc.username);
    setInputValue(info.password, acc.password);
    highlight(info.username);
    highlight(info.password);

    if (settings.rememberMe) {
      const checkbox = document.querySelector(SELECTORS.remember);
      if (checkbox && !checkbox.checked) {
        try {
          checkbox.click();
        } catch (e) {
          /* ignore */
        }
      }
    }
    if (focus) {
      try {
        info.password.focus();
        if (typeof info.password.select === 'function') info.password.select();
      } catch (e) {
        /* ignore */
      }
    }
    return true;
  }

  /* ───────────────────────────── 自动提交 ───────────────────────────── */

  function readGuard() {
    try {
      const raw = sessionStorage.getItem(GUARD_KEY);
      if (!raw) return { count: 0, lastAt: 0, failed: 0 };
      const parsed = JSON.parse(raw);
      return {
        count: Number(parsed && parsed.count) || 0,
        lastAt: Number(parsed && parsed.lastAt) || 0,
        failed: Number(parsed && parsed.failed) || 0
      };
    } catch (e) {
      return { count: 0, lastAt: 0, failed: 0 };
    }
  }

  function writeGuard(value) {
    try {
      sessionStorage.setItem(GUARD_KEY, JSON.stringify(value));
    } catch (e) {
      /* ignore */
    }
  }

  function resetGuard() {
    try {
      sessionStorage.removeItem(GUARD_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  // 跨标签页的失败记忆：某个账户刚登录失败时，其它标签页也不要再拿旧密码去撞 CAS。
  function readGlobalFailure() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(FAILURE_KEY, function (items) {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          const failure = items && items[FAILURE_KEY];
          if (!failure || !failure.at) {
            resolve(null);
            return;
          }
          if (Date.now() - failure.at > FAILURE_TTL_MS) {
            clearGlobalFailure();
            resolve(null);
            return;
          }
          resolve(failure);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function writeGlobalFailure(message) {
    try {
      const payload = {};
      payload[FAILURE_KEY] = {
        at: Date.now(),
        message: String(message || '').slice(0, 80),
        username: account ? account.username : ''
      };
      chrome.storage.local.set(payload);
    } catch (e) {
      /* ignore */
    }
  }

  function clearGlobalFailure() {
    try {
      chrome.storage.local.remove(FAILURE_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  function waitForPageReady(timeoutMs) {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise(function (resolve) {
      let timer = 0;
      function done() {
        if (timer) clearTimeout(timer);
        document.removeEventListener('readystatechange', onChange);
        resolve();
      }
      function onChange() {
        if (document.readyState === 'complete') done();
      }
      document.addEventListener('readystatechange', onChange);
      timer = setTimeout(done, timeoutMs);
    });
  }

  function dispatchEnter(target) {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true
    });
    try {
      Object.defineProperty(event, 'keyCode', { get: function () { return 13; } });
      Object.defineProperty(event, 'which', { get: function () { return 13; } });
    } catch (e) {
      /* ignore */
    }
    (target || document).dispatchEvent(event);
  }

  function waitForPasswordEncrypted(input, plainValue, timeoutMs) {
    return new Promise(function (resolve) {
      const startedAt = Date.now();
      function tick() {
        if (!input || !input.isConnected) {
          // 页面重新渲染了表单但没有跳转时，无法确认提交结果，按「未确认」处理
          resolve(false);
          return;
        }
        const value = input.value;
        if (value && value !== plainValue && value.length >= 32) {
          resolve(true);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tick, 120);
      }
      setTimeout(tick, 120);
    });
  }

  async function autoSubmit(info, force, pendingError) {
    if (lastClickAt && Date.now() - lastClickAt < 5000) return false;

    if (isCaptchaVisible()) {
      toast('页面要求验证码：账号密码已填好，请输入验证码后手动点「登录」', 'warn', 10000);
      return false;
    }

    const serverError = pendingError || readServerError();
    if (serverError && !force) {
      const current = readGuard();
      writeGuard({ count: current.count, lastAt: Date.now(), failed: 2 });
      writeGlobalFailure(serverError);
      toast('上次自动登录未成功：' + serverError + '。已暂停自动提交，请检查账户或手动登录。', 'error', 12000);
      return false;
    }

    if (!force) {
      const globalFailure = await readGlobalFailure();
      if (
        globalFailure &&
        (!globalFailure.username || !account || globalFailure.username === account.username)
      ) {
        toast(
          '自动登录已暂停：本机最近检测到该账户登录失败（' + globalFailure.message + '）。请修正账户后点击扩展图标手动重试。',
          'error',
          12000
        );
        return false;
      }
    }

    const guard = readGuard();
    const now = Date.now();
    const minInterval = Math.max(3000, Number(settings.minSubmitIntervalMs) || 15000);
    const maxAttempts = Math.max(1, Number(settings.maxAutoAttempts) || 3);

    if (!force) {
      if (guard.failed >= 2) {
        toast('自动登录已因上次失败而暂停。点击扩展图标可手动重试。', 'warn', 9000);
        return false;
      }
      if (guard.count > 0 && now - guard.lastAt < minInterval) {
        // 刚提交过、页面又刷回登录页：不再触发，避免刷新死循环
        return false;
      }
      if (guard.count >= maxAttempts) {
        toast('自动提交次数过多（' + guard.count + ' 次），已暂停。请检查账户或手动登录。', 'error', 10000);
        return false;
      }
    }

    // 填充后只等 settings.submitDelayMs（默认 150ms，最少 120ms），等待期间持续轮询验证码；
    // 不再先 sleep 再额外轮询 1200ms，否则从填完密码到点「登录」会有约 1.5 秒的明显空档。
    const preClickDelay = Math.max(120, Number(settings.submitDelayMs) || 0);
    if (await waitForCaptchaState(preClickDelay)) {
      toast('页面要求验证码：账号密码已填好，请输入验证码后手动点「登录」', 'warn', 10000);
      return false;
    }

    const fresh = readForm();
    if (!fresh) return false;

    const plainPassword = fresh.password.value;
    const nextCount = force ? 1 : guard.count + 1;
    lastClickAt = Date.now();
    writeGuard({ count: nextCount, lastAt: lastClickAt, failed: force ? 0 : guard.failed });

    await waitForPageReady(3000);

    if (fresh.submit) {
      fresh.submit.click();
    } else {
      dispatchEnter(fresh.password);
    }

    const encrypted = await waitForPasswordEncrypted(fresh.password, plainPassword, 4000);
    if (encrypted) {
      // 表单已经被页面加密提交，本次自动登录结束：清掉本标签页与全局的失败记忆。
      resetGuard();
      clearGlobalFailure();
      toast('已提交登录，等待页面跳转…', 'success', 5000);
    } else if (isCaptchaVisible()) {
      toast('页面要求验证码：请完成验证码后手动登录', 'warn', 10000);
    } else {
      toast('自动提交未生效：账号密码已填好，请手动点击「登录」', 'warn', 10000);
    }
    return encrypted;
  }

  /* ───────────────────────────── 轻提示 ───────────────────────────── */

  function toast(text, tone, duration) {
    if (location.origin !== ORIGIN) return;
    if (!settings.showToast && tone !== 'error') return;
    try {
      if (!toastEl || !toastEl.isConnected) {
        toastEl = document.createElement('div');
        toastEl.id = TOAST_ID;
        (document.body || document.documentElement).appendChild(toastEl);
      }
      toastEl.textContent = text;
      toastEl.className =
        'zjuamin-toast zjuamin-toast--' + (tone || 'info') + ' zjuamin-toast--show';
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        if (toastEl) toastEl.className = 'zjuamin-toast zjuamin-toast--' + (tone || 'info');
      }, duration || 5000);
    } catch (e) {
      /* ignore */
    }
  }

  /* ───────────────────────────── 消息 ───────────────────────────── */

  function pingResponse() {
    const info = readForm();
    return {
      ok: true,
      hasForm: !!info,
      accountLabel: account ? account.label : '',
      url: location.href
    };
  }

  async function handleMessage(message) {
    if (message.type === 'PING') return pingResponse();

    await readyPromise;

    switch (message.type) {
      case 'FILL': {
        await reloadState();
        if (!account) return { ok: false, error: 'NO_ACCOUNT' };
        const info = readForm();
        if (!info) return { ok: false, error: 'NO_FORM' };
        fillForm(account, true);
        toast('已填充账户「' + account.label + '」', 'info');
        return { ok: true, accountLabel: account.label };
      }
      case 'FILL_AND_SUBMIT': {
        await reloadState();
        if (!account) return { ok: false, error: 'NO_ACCOUNT' };
        const info = readForm();
        if (!info) return { ok: false, error: 'NO_FORM' };
        const pendingError = readServerError();
        resetGuard();
        clearGlobalFailure();
        fillForm(account, false);
        toast('使用账户「' + account.label + '」自动登录…', 'info');
        const submitted = await autoSubmit(info, true, pendingError);
        return { ok: true, submitted: submitted, accountLabel: account.label };
      }
      case 'STATE_CHANGED': {
        await reloadState();
        if (settings.autoFill && account) {
          const info = readForm();
          if (info) fillForm(account, false);
        }
        return { ok: true, accountLabel: account ? account.label : '' };
      }
      case 'RESET_GUARD':
        resetGuard();
        return { ok: true };
      default:
        return { ok: false, error: 'UNKNOWN_MESSAGE' };
    }
  }
})();
