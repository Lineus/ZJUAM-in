'use strict';

/**
 * 真实站点冒烟测试（只填充、不提交）。
 *
 * 用真实的扩展代码（未打补丁）加载到无头 Edge，在真实 zjuam 登录页上验证：
 *   - 扩展能被注入并识别登录表单；
 *   - 能自动填入一个假账户的学号与密码；
 *   - 因为 autoSubmit 关闭，不会点击登录、不会向学校提交任何内容。
 *
 * 它只读取真实页面结构，绝不提交密码。运行：node tools/e2e/smoke-real.js
 * 若网络无法访问 zjuam，脚本会明确报错退出，不影响 mock E2E 的结果。
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { CDP } = require('./cdp');

const ROOT = path.resolve(__dirname, '..', '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const TEMP_ROOT = path.join(os.tmpdir(), 'zjuamin-real-smoke');
const PROFILE_DIR = path.join(os.tmpdir(), 'md2pdf-edge-profile');
const PROFILE_LOCK = path.join(os.tmpdir(), 'md2pdf-edge-profile.lock');
const LOGIN_URL = 'https://zjuam.zju.edu.cn/cas/login';
const KEY = 'zjuamin.state.v1';
const FAKE_USER = '0000000000';
const FAKE_PASS = 'SmokeTest!2026';

const results = [];
let failed = false;
let cdp = null;
let edge = null;
let lastPage = null;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (!ok && detail !== undefined ? '  [' + detail + ']' : ''));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function copyTree(source, dest) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(source)) copyTree(path.join(source, entry), path.join(dest, entry));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
  }
}

const lockSleeper = new Int32Array(new SharedArrayBuffer(4));

function acquireProfileLock(timeoutMs) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const deadline = Date.now() + (timeoutMs || 120000);
  for (;;) {
    try {
      const fd = fs.openSync(PROFILE_LOCK, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let stale = false;
    try {
      const holder = Number.parseInt(fs.readFileSync(PROFILE_LOCK, 'utf8').trim(), 10) || 0;
      if (holder > 0) {
        try {
          process.kill(holder, 0);
        } catch (error) {
          if (error.code === 'ESRCH') stale = true;
        }
      } else {
        stale = true;
      }
    } catch (error) {
      stale = true;
    }
    if (stale) {
      fs.rmSync(PROFILE_LOCK, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error('等待 md2pdf-edge-profile 锁超时');
    Atomics.wait(lockSleeper, 0, 0, 1000);
  }
}

function releaseProfileLock() {
  try {
    fs.rmSync(PROFILE_LOCK, { force: true });
  } catch (error) {
    /* ignore */
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function launchEdge(extDir) {
  const port = await getFreePort();
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--mute-audio',
      '--user-data-dir=' + PROFILE_DIR,
      '--load-extension=' + extDir,
      '--disable-extensions-except=' + extDir,
      '--remote-debugging-port=' + port,
      '--remote-allow-origins=*',
      'about:blank'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  child.stdout.on('data', () => {});
  const state = { child, port, exited: false };
  child.on('exit', () => {
    state.exited = true;
  });

  const deadline = Date.now() + 45000;
  for (;;) {
    if (state.exited) throw new Error('Edge 提前退出\n' + stderr.join('').slice(-3000));
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1000) });
      if (res.ok) break;
    } catch (error) {
      /* 等待 */
    }
    if (Date.now() > deadline) throw new Error('等待 Edge CDP 端口超时');
    await sleep(250);
  }
  return state;
}

function registerSession(page) {
  cdp.on('Runtime.exceptionThrown', (params, sessionId) => {
    if (sessionId !== page.sessionId) return;
    const details = params.exceptionDetails || {};
    const text = (details.exception && (details.exception.description || details.exception.value)) || details.text;
    page.errors.push('exception: ' + String(text).split('\n')[0]);
  });
  cdp.on('Runtime.consoleAPICalled', (params, sessionId) => {
    if (sessionId !== page.sessionId || params.type !== 'error') return;
    page.errors.push('console.error');
  });
  cdp.on('Log.entryAdded', (params, sessionId) => {
    if (sessionId !== page.sessionId) return;
    const entry = params.entry || {};
    if (entry.level === 'error') page.errors.push('log: ' + (entry.text || '') + ' ' + (entry.url || ''));
  });
  cdp.on('Page.javascriptDialogOpening', (params, sessionId) => {
    if (sessionId !== page.sessionId) return;
    cdp.send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
  });
}

async function attachPage(targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = { targetId, sessionId, errors: [] };
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  registerSession(page);
  return page;
}

async function createPage(url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  return attachPage(targetId);
}

async function evaluate(page, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    page.sessionId
  );
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const text = (details.exception && (details.exception.description || details.exception.value)) || details.text;
    throw new Error('页面脚本异常: ' + String(text).split('\n').slice(0, 3).join(' | '));
  }
  return result.result ? result.result.value : undefined;
}

async function waitForEval(page, expression, predicate, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 15000);
  let last;
  for (;;) {
    try {
      last = await evaluate(page, expression);
    } catch (error) {
      last = 'ERROR: ' + error.message.split('\n')[0];
    }
    if (predicate(last)) return last;
    if (Date.now() > deadline) throw new Error('等待超时: ' + label + '（最后结果: ' + JSON.stringify(last) + '）');
    await sleep(200);
  }
}

async function main() {
  console.log('== ZJUAMin 真实站点冒烟（只填充、不提交）==');
  if (!fs.existsSync(EDGE)) throw new Error('找不到 Edge: ' + EDGE);

  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const extDir = path.join(TEMP_ROOT, 'ext');
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.mkdirSync(extDir, { recursive: true });
  for (const entry of ['manifest.json', 'background.js', 'shared', 'content', 'popup', 'options', 'icons']) {
    copyTree(path.join(ROOT, entry), path.join(extDir, entry));
  }

  acquireProfileLock();
  console.log('已获取无头 Edge profile 锁');
  try {
    edge = await launchEdge(extDir);
    cdp = await CDP.connect(edge.port);

    const worker = await (async () => {
      const deadline = Date.now() + 45000;
      for (;;) {
        const { targetInfos } = await cdp.send('Target.getTargets');
        const found = targetInfos.find(
          (info) => info.type === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(info.url)
        );
        if (found) return found;
        if (Date.now() > deadline) throw new Error('扩展 service worker 未启动');
        await sleep(300);
      }
    })();
    await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    check('真实扩展 service worker 已启动', true, worker.url);
    const extensionId = /^chrome-extension:\/\/([a-p]{32})\//.exec(worker.url)[1];

    // 无头 Edge 下，CDP 在扩展 Service Worker 的默认上下文里拿不到 chrome.*，
    // 因此改从扩展自己的选项页写 storage（等价于真实用户在设置页添加账户）。
    const page = await createPage('chrome-extension://' + extensionId + '/options/options.html');
    lastPage = page;
    await waitForEval(page, 'document.readyState', (value) => value === 'complete', 20000, '扩展选项页加载');
    await waitForEval(page, 'typeof chrome', (value) => value === 'object', 20000, '扩展 API 可用');

    const state = {
      schemaVersion: 1,
      activeAccountId: 'acc_smoke',
      accounts: [
        {
          id: 'acc_smoke',
          label: '冒烟测试',
          username: FAKE_USER,
          password: FAKE_PASS,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ],
      settings: {
        autoFill: true,
        autoSubmit: false,
        rememberMe: false,
        showToast: true,
        submitDelayMs: 350,
        minSubmitIntervalMs: 15000,
        maxAutoAttempts: 3
      }
    };
    const writeResult = await evaluate(
      page,
      'chrome.storage.local.set({ ' +
        JSON.stringify(KEY) +
        ': ' +
        JSON.stringify(state) +
        ' }).then(function(){ return "ok"; }, function(error){ return "write-error: " + (error && error.message); })'
    );
    const writtenState = await evaluate(
      page,
      'new Promise(function(resolve){ chrome.storage.local.get(' +
        JSON.stringify(KEY) +
        ', function(items){ var state = items[' +
        JSON.stringify(KEY) +
        ']; resolve({ count: state && state.accounts ? state.accounts.length : 0, username: state && state.accounts && state.accounts[0] ? state.accounts[0].username : "" }); }); })'
    );
    check(
      '假账户写入成功（storage 读回一致）',
      writeResult === 'ok' && Boolean(writtenState) && writtenState.count === 1 && writtenState.username === FAKE_USER,
      String(writeResult) + ' ' + JSON.stringify(writtenState)
    );

    await cdp.send('Page.navigate', { url: LOGIN_URL }, page.sessionId);
    const loadedHref = await waitForEval(
      page,
      'location.href',
      (value) => typeof value === 'string' && value.indexOf('zjuam.zju.edu.cn') >= 0,
      45000,
      '真实登录页导航'
    );
    console.log('  当前地址: ' + loadedHref);
    await waitForEval(page, 'document.readyState', (value) => value === 'complete', 30000, '真实登录页加载');
    await sleep(1200);

    const formInfo = await evaluate(
      page,
      '(function(){ return {' +
        '  href: location.href,' +
        '  hasForm: Boolean(document.querySelector("#fm1, form[action*=\\"/cas/login\\"]")),' +
        '  hasUsername: Boolean(document.querySelector("#username")),' +
        '  hasPassword: Boolean(document.querySelector("#password")),' +
        '  hasSubmit: Boolean(document.querySelector("#dl")),' +
        '  execution: Boolean(document.querySelector("input[name=execution]"))' +
        '}; })()'
    );
    check('真实页面加载成功且仍是登录页', formInfo.href.indexOf('zjuam.zju.edu.cn') >= 0, formInfo.href);
    check('识别到登录表单 / 用户名 / 密码 / 登录按钮', formInfo.hasForm && formInfo.hasUsername && formInfo.hasPassword && formInfo.hasSubmit, JSON.stringify(formInfo));
    check('页面含 CAS execution 隐藏字段', formInfo.execution);

    const filled = await waitForEval(
      page,
      '(function(){ var u=document.getElementById("username"); return { username: u ? u.value : "", password: (document.getElementById("password")||{}).value || "" }; })()',
      (value) => value && value.username === FAKE_USER,
      20000,
      '真实页面自动填充'
    );
    check('真实页面自动填入学号', filled.username === FAKE_USER, filled.username);
    check('真实页面自动填入密码（未提交、保持明文）', filled.password === FAKE_PASS, filled.password.length + ' 字符');

    const beforeStable = await evaluate(
      page,
      '(function(){ return { href: location.href, password: (document.getElementById("password") || {}).value || "" }; })()'
    );

    const toast = await evaluate(page, '(document.getElementById("zjuamin-toast") || {}).textContent || ""');
    check('页面底部显示填充提示', /已填入|已填充/.test(toast), toast);
    await sleep(1500);
    const afterStable = await evaluate(
      page,
      '(function(){ return { href: location.href, password: (document.getElementById("password") || {}).value || "" }; })()'
    );
    check(
      '页面未跳转（location.href 未变化，没有提交登录）',
      beforeStable.href === afterStable.href && afterStable.href.indexOf('/cas/login') >= 0,
      beforeStable.href + ' -> ' + afterStable.href
    );
    check('密码框仍为明文（页面未加密提交）', afterStable.password === FAKE_PASS, afterStable.password.length + ' 字符');

    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false },
      page.sessionId
    );
    await sleep(300);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, page.sessionId);
    const shotDir = path.join(ROOT, 'docs', 'screenshots');
    fs.mkdirSync(shotDir, { recursive: true });
    const shotPath = path.join(shotDir, 'real-login-filled.png');
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('  screenshot → ' + shotPath);

    check('真实页面没有 JS 异常', page.errors.length === 0, page.errors.join(' | '));

    // 清理测试写入的账户，避免残留在固定 profile 里（另开扩展页，因为主页面已导航到真实站点）
    const cleanupPage = await createPage('chrome-extension://' + extensionId + '/options/options.html');
    await waitForEval(cleanupPage, 'typeof chrome', (value) => value === 'object', 15000, '清理页扩展 API');
    await evaluate(cleanupPage, 'chrome.storage.local.clear().then(function(){ return true; })');
    await cdp.send('Target.closeTarget', { targetId: cleanupPage.targetId }).catch(() => {});
    await cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
  } finally {
    try {
      if (cdp) {
        await cdp.send('Browser.close').catch(() => {});
        cdp.close();
      }
    } catch (error) {
      /* ignore */
    }
    if (edge) {
      await Promise.race([new Promise((resolve) => edge.child.once('exit', resolve)), sleep(8000)]);
      if (!edge.exited) {
        try {
          edge.child.kill('SIGKILL');
        } catch (error) {
          /* ignore */
        }
      }
    }
    releaseProfileLock();
    try {
      fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
    } catch (error) {
      /* ignore */
    }
  }
}

(async () => {
  try {
    await main();
  } catch (error) {
    failed = true;
    console.error('\n真实站点冒烟失败:\n' + (error && error.stack ? error.stack : String(error)));
    if (lastPage && lastPage.errors && lastPage.errors.length) {
      console.error('页面错误: ' + lastPage.errors.join(' | '));
    }
  }
  const passed = results.filter((result) => result.ok).length;
  console.log('\n== 结果: ' + passed + ' / ' + results.length + ' 项通过 ==');
  process.exit(failed ? 1 : 0);
})();
