'use strict';

/**
 * ZJUAM-in 端到端测试（零依赖）。
 *
 * 做什么：
 *   1. 把扩展复制到临时目录，生成固定扩展 ID 的测试副本，匹配 http://127.0.0.1:*；
 *   2. 启动本地 mock CAS（复刻 zjuam 登录页结构与「反转密码 + RSA」提交逻辑）；
 *   3. 复用固定无头 Edge profile（%TEMP%\md2pdf-edge-profile，带锁）加载扩展；
 *   4. 用 CDP 驱动设置页 / 弹窗 / 登录页，验证：
 *      - 多账户增删改、去重、导入导出、切换生效账户；
 *      - 认证页自动填充并自动提交、使用的账户正确、密码加密链路正确；
 *      - 密码错误后不重复提交、需要验证码时不自动提交、关掉开关后只填不交；
 *   5. 截图到 docs/screenshots。
 *
 * 运行：node tools/e2e/run.js
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { CDP } = require('./cdp');
const { startMockCasServer } = require('./mock-cas-server');

const ROOT = path.resolve(__dirname, '..', '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const TEMP_ROOT = path.join(os.tmpdir(), 'zjuamin-e2e');
const PROFILE_DIR = path.join(os.tmpdir(), 'md2pdf-edge-profile');
const PROFILE_LOCK = path.join(os.tmpdir(), 'md2pdf-edge-profile.lock');
const SCREENSHOT_DIR = path.join(ROOT, 'docs', 'screenshots');

const results = [];
let failed = false;
let mock = null;
let cdp = null;
let edge = null;

/* ───────────────────────── 输出与断言 ───────────────────────── */

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  if (!ok) failed = true;
  const prefix = ok ? '  ok   ' : '  FAIL ';
  console.log(prefix + name + (!ok && detail !== undefined ? '  [' + detail + ']' : ''));
}

function section(title) {
  console.log('\n── ' + title + ' ──');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(fn, timeoutMs, intervalMs, label) {
  const deadline = Date.now() + timeoutMs;
  const step = intervalMs || 120;
  return (async () => {
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > deadline) throw new Error('等待超时: ' + (label || '条件'));
      await sleep(step);
    }
  })();
}

/* ───────────────────────── 临时目录 / 测试扩展 ───────────────────────── */

function deriveExtensionId(spkiDer) {
  const hash = crypto.createHash('sha256').update(spkiDer).digest();
  const alphabet = 'abcdefghijklmnop';
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    const byte = hash[i];
    id += alphabet[byte >> 4] + alphabet[byte & 0x0f];
  }
  return id;
}

// 注意：本机 Node 24.14.1 在从 OneDrive 工作区用 fs.cpSync 复制目录时会直接终止进程
// （exit 127，无异常），因此这里手写递归复制，仅使用 statSync/readdirSync/copyFileSync。
function copyTree(source, dest) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyTree(path.join(source, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
  }
}

function buildTestExtension() {
  const extDir = path.join(TEMP_ROOT, 'ext');
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.mkdirSync(extDir, { recursive: true });

  const entries = ['manifest.json', 'background.js', 'shared', 'content', 'popup', 'options', 'icons'];
  for (const entry of entries) {
    const source = path.join(ROOT, entry);
    if (!fs.existsSync(source)) throw new Error('缺少扩展文件: ' + entry);
    copyTree(source, path.join(extDir, entry));
  }

  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });
  const extensionId = deriveExtensionId(publicKey);

  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.key = publicKey.toString('base64');
  manifest.host_permissions = ['http://127.0.0.1/*'];
  if (Array.isArray(manifest.content_scripts) && manifest.content_scripts[0]) {
    manifest.content_scripts[0].matches = ['http://127.0.0.1/*'];
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // 测试专用补丁：content script 内部有 location.origin 必须等于 zjuam 的硬校验，
  // 在 mock 站点上让它接受当前 origin（真实扩展保持原样）。
  const contentPath = path.join(extDir, 'content', 'content.js');
  const contentSource = fs.readFileSync(contentPath, 'utf8');
  const originLine = "const ORIGIN = 'https://zjuam.zju.edu.cn';";
  if (contentSource.indexOf(originLine) === -1) {
    throw new Error('content.js 的 ORIGIN 行与测试补丁不匹配，请同步修改 tools/e2e/run.js');
  }
  fs.writeFileSync(contentPath, contentSource.replace(originLine, 'const ORIGIN = location.origin;'));

  return { extDir, extensionId };
}

/* ───────────────────────── profile 锁（与 md2pdf 技能一致） ───────────────────────── */

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
    let holder = 0;
    try {
      holder = Number.parseInt(fs.readFileSync(PROFILE_LOCK, 'utf8').trim(), 10) || 0;
    } catch (error) {
      stale = true;
    }
    if (!stale && holder > 0) {
      try {
        process.kill(holder, 0);
      } catch (error) {
        if (error.code === 'ESRCH') stale = true;
      }
    } else if (!stale && holder === 0) {
      try {
        const stat = fs.statSync(PROFILE_LOCK);
        if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) stale = true;
      } catch (error) {
        stale = true;
      }
    }
    if (stale) {
      try {
        fs.rmSync(PROFILE_LOCK, { force: true });
      } catch (error) {
        /* ignore */
      }
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error('等待 md2pdf-edge-profile 锁超时（另一个无头 Edge 正在使用该 profile）');
    }
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

/* ───────────────────────── Edge 启动 / CDP ───────────────────────── */

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
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--disable-default-apps',
    '--metrics-recording-only',
    '--mute-audio',
    '--user-data-dir=' + PROFILE_DIR,
    '--load-extension=' + extDir,
    '--disable-extensions-except=' + extDir,
    '--remote-debugging-port=' + port,
    '--remote-allow-origins=*',
    'about:blank'
  ];

  const child = spawn(EDGE, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const stderrChunks = [];
  child.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk.toString());
    if (stderrChunks.length > 500) stderrChunks.shift();
  });
  child.stdout.on('data', () => {});
  const state = { child, port, exited: false };
  child.on('exit', () => {
    state.exited = true;
  });

  const deadline = Date.now() + 45000;
  for (;;) {
    if (state.exited) {
      throw new Error('Edge 启动后提前退出\n' + stderrChunks.join('').slice(-4000));
    }
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version', {
        signal: AbortSignal.timeout(1000)
      });
      if (res.ok) break;
    } catch (error) {
      /* 还没起来 */
    }
    if (Date.now() > deadline) {
      throw new Error('等待 Edge CDP 端口超时\n' + stderrChunks.join('').slice(-4000));
    }
    await sleep(250);
  }

  return {
    ...state,
    port,
    recentStderr: () => stderrChunks.join('').slice(-6000),
    kill: () => {
      try {
        child.kill('SIGKILL');
      } catch (error) {
        /* ignore */
      }
    }
  };
}

async function waitExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(timeoutMs)
  ]);
}

async function findExtensionServiceWorker(extensionId) {
  return waitFor(
    async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return (
        targetInfos.find(
          (info) => info.url === 'chrome-extension://' + extensionId + '/background.js' ||
            (info.type === 'service_worker' && info.url.indexOf('chrome-extension://' + extensionId + '/') === 0)
        ) || null
      );
    },
    45000,
    300,
    '扩展 service worker 注册'
  );
}

function registerGlobalHandlers() {
  cdp.on('Page.javascriptDialogOpening', (params, sessionId) => {
    if (!sessionId) return;
    cdp
      .send('Page.handleJavaScriptDialog', { accept: true }, sessionId)
      .catch(() => {});
  });
}

/* ───────────────────────── 页面封装 ───────────────────────── */

async function createPage(url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = { targetId, sessionId, url, errors: [] };

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);

  cdp.on('Runtime.exceptionThrown', (params, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    const details = params.exceptionDetails || {};
    const description =
      (details.exception && (details.exception.description || details.exception.value)) || details.text || '未知异常';
    page.errors.push('exception: ' + String(description).split('\n')[0]);
  });
  cdp.on('Runtime.consoleAPICalled', (params, eventSessionId) => {
    if (eventSessionId !== sessionId || params.type !== 'error') return;
    const text = (params.args || [])
      .map((arg) => (arg.value !== undefined ? arg.value : arg.description || arg.type))
      .join(' ');
    page.errors.push('console.error: ' + text);
  });
  cdp.on('Log.entryAdded', (params, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    const entry = params.entry || {};
    if (entry.level === 'error') page.errors.push('log: ' + (entry.text || ''));
  });

  return page;
}

async function evaluate(page, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    page.sessionId
  );
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const description =
      (details.exception && (details.exception.description || details.exception.value)) || details.text;
    throw new Error('页面脚本异常: ' + String(description).split('\n').slice(0, 3).join(' | '));
  }
  return result.result ? result.result.value : undefined;
}

async function waitForEval(page, expression, expected, timeoutMs, label) {
  const matches = typeof expected === 'function' ? expected : (value) => value === expected;
  const deadline = Date.now() + (timeoutMs || 10000);
  let last;
  for (;;) {
    try {
      last = await evaluate(page, expression);
    } catch (error) {
      last = 'ERROR: ' + error.message.split('\n')[0];
    }
    if (matches(last)) return last;
    if (Date.now() > deadline) {
      throw new Error('等待条件超时: ' + (label || expression) + '（最后结果: ' + JSON.stringify(last) + '）');
    }
    await sleep(120);
  }
}

async function waitPageLoaded(page, timeoutMs) {
  await waitForEval(page, 'document.readyState', (value) => value === 'complete', timeoutMs || 20000, '页面加载完成');
}

async function closePage(page) {
  try {
    await cdp.send('Target.closeTarget', { targetId: page.targetId });
  } catch (error) {
    /* ignore */
  }
}

async function screenshot(page, fileName) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, page.sessionId);
  fs.writeFileSync(fileName, Buffer.from(data, 'base64'));
  console.log('  screenshot → ' + path.relative(ROOT, fileName));
}

async function setViewport(page, width, height) {
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false },
    page.sessionId
  );
  await sleep(250);
}

async function clickBySelector(page, selector) {
  const clicked = await evaluate(
    page,
    '(function(){ var el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return false; el.click(); return true; })()'
  );
  if (!clicked) throw new Error('找不到可点击元素: ' + selector);
  await sleep(150);
}

async function storageState(page) {
  return evaluate(
    page,
    '(async function(){ var st = await ZJUAM.loadState(); return { accounts: st.accounts, activeAccountId: st.activeAccountId, settings: st.settings }; })()'
  );
}

async function fillAndSubmitAccountForm(page, account) {
  const script =
    '(function(){' +
    '  function setValue(id, value) {' +
    '    var el = document.getElementById(id);' +
    '    var descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");' +
    '    descriptor.set.call(el, value);' +
    '    el.dispatchEvent(new Event("input", { bubbles: true }));' +
    '    el.dispatchEvent(new Event("change", { bubbles: true }));' +
    '  }' +
    '  setValue("fieldLabel", ' + JSON.stringify(account.label) + ');' +
    '  setValue("fieldUsername", ' + JSON.stringify(account.username) + ');' +
    '  setValue("fieldPassword", ' + JSON.stringify(account.password) + ');' +
    '  document.getElementById("fieldMakeActive").checked = ' + Boolean(account.makeActive) + ';' +
    '  document.getElementById("saveAccountBtn").click();' +
    '  return true;' +
    '})()';
  await evaluate(page, script);
}

async function waitForFile(dir, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((name) => pattern.test(name) && !name.endsWith('.crdownload'))
      : [];
    if (files.length) return path.join(dir, files[0]);
    if (Date.now() > deadline) throw new Error('等待文件超时: ' + pattern);
    await sleep(200);
  }
}

/* ───────────────────────── 设置页 / 账户 ───────────────────────── */

async function testOptionsAndAccounts(extBaseUrl) {
  section('设置页：多账户 CRUD / 导入导出');

  const page = await createPage(extBaseUrl + '/options/options.html');
  await waitPageLoaded(page);
  await waitForEval(page, 'document.title', 'ZJUAM-in 设置', 15000, '设置页标题');

  // 固定 profile 会被复用，先清空上一轮可能留下的数据
  await evaluate(page, 'chrome.storage.local.clear().then(function(){ return true; })');
  await cdp.send('Page.reload', {}, page.sessionId);
  await waitPageLoaded(page);
  await waitForEval(
    page,
    'document.querySelectorAll("#accountList .account-item").length',
    0,
    8000,
    '清空后列表为空'
  );

  const version = await evaluate(page, 'document.getElementById("versionText").textContent');
  check('设置页显示扩展版本号', /^v\d+\.\d+\.\d+$/.test(version), version);

  const A = { label: '个人账号', username: '3200100001', password: 'ZjuTest!2024' };
  const B = { label: '实验室账号', username: '3200100002', password: 'LabPass#2024' };

  await fillAndSubmitAccountForm(page, { ...A, makeActive: true });
  await waitForEval(
    page,
    'ZJUAM.loadState().then(function(s){ return s.accounts.length; })',
    1,
    8000,
    '添加账户 A'
  );
  let state = await storageState(page);
  check(
    '账户 A 保存成功（名称 / 学号 / 密码）',
    state.accounts.length === 1 &&
      state.accounts[0].label === A.label &&
      state.accounts[0].username === A.username &&
      state.accounts[0].password === A.password
  );
  const aId = state.accounts[0].id;
  check('第一个账户自动成为当前账户', state.activeAccountId === aId, state.activeAccountId);

  await fillAndSubmitAccountForm(page, { ...B, makeActive: false });
  await waitForEval(
    page,
    'ZJUAM.loadState().then(function(s){ return s.accounts.length; })',
    2,
    8000,
    '添加账户 B'
  );
  state = await storageState(page);
  const bId = (state.accounts.find((account) => account.username === B.username) || {}).id;
  check('账户 B 保存成功', Boolean(bId) && state.accounts.length === 2);
  check('添加非当前账户后当前账户仍是 A', state.activeAccountId === aId);

  const listDom = await evaluate(
    page,
    '(function(){' +
      '  var items = document.querySelectorAll("#accountList .account-item");' +
      '  var active = document.querySelectorAll("#accountList .account-item.is-active");' +
      '  return {' +
      '    total: items.length,' +
      '    activeCount: active.length,' +
      '    activeName: active[0] ? active[0].querySelector(".account-name").textContent : "",' +
      '    chip: active[0] ? (active[0].querySelector(".chip") || {}).textContent || "" : "",' +
      '    count: document.getElementById("accountCount").textContent' +
      '  };' +
      '})()'
  );
  check('账户列表展示 2 项且只有 1 个「当前」标记', listDom.total === 2 && listDom.activeCount === 1);
  check('「当前」标记在账户 A 上', listDom.activeName.indexOf(A.label) === 0 && listDom.chip === '当前', listDom.activeName);
  check('账户数量徽标显示「2 个」', listDom.count.indexOf('2') >= 0, listDom.count);

  // 重复学号
  await fillAndSubmitAccountForm(page, { label: '重复账户', username: A.username, password: 'whatever', makeActive: false });
  await waitForEval(
    page,
    'document.getElementById("formError").textContent',
    (value) => typeof value === 'string' && value.indexOf('已存在') >= 0,
    5000,
    '重复学号提示'
  );
  state = await storageState(page);
  check('重复学号被拒绝，未新增账户', state.accounts.length === 2);
  await evaluate(page, 'document.getElementById("resetFormBtn").click(); true');

  // 切换当前账户
  await clickBySelector(page, 'button[data-act="active"][data-id="' + bId + '"]');
  await waitForEval(
    page,
    'ZJUAM.loadState().then(function(s){ return s.activeAccountId; })',
    bId,
    6000,
    '切换当前账户到 B'
  );
  const activeDom = await evaluate(
    page,
    '(function(){' +
      '  var active = document.querySelector("#accountList .account-item.is-active");' +
      '  return { name: active ? active.querySelector(".account-name").textContent : "" };' +
      '})()'
  );
  check('点击「设为当前」后列表标记切到账户 B', activeDom.name.indexOf(B.label) === 0, activeDom.name);

  // 编辑账户
  await clickBySelector(page, 'button[data-act="edit"][data-id="' + aId + '"]');
  const editor = await evaluate(
    page,
    '(function(){ return {' +
      '  title: document.getElementById("editorTitle").textContent,' +
      '  label: document.getElementById("fieldLabel").value,' +
      '  username: document.getElementById("fieldUsername").value' +
      '}; })()'
  );
  check('编辑账户时表单正确回填', editor.title === '编辑账户' && editor.label === A.label && editor.username === A.username);

  const newLabel = A.label + '（改）';
  await fillAndSubmitAccountForm(page, { label: newLabel, username: A.username, password: A.password, makeActive: false });
  await waitForEval(
    page,
    'ZJUAM.loadState().then(function(s){ var a = s.accounts.filter(function(x){ return x.id === ' +
      JSON.stringify(aId) +
      '; })[0]; return a ? a.label : ""; })',
    newLabel,
    6000,
    '保存账户 A 的修改'
  );
  state = await storageState(page);
  check('编辑账户后名称已更新且账户数不变', state.accounts.length === 2 && state.accounts.some((account) => account.label === newLabel));

  // 导出
  const downloadDir = path.join(TEMP_ROOT, 'downloads');
  fs.rmSync(downloadDir, { recursive: true, force: true });
  fs.mkdirSync(downloadDir, { recursive: true });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });
  await clickBySelector(page, '#exportBtn');
  const exportFile = await waitForFile(downloadDir, /^zjuamin-accounts-.*\.json$/, 10000);
  const exported = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
  check(
    '导出 JSON 含 2 个账户与明文密码',
    Array.isArray(exported.accounts) &&
      exported.accounts.length === 2 &&
      exported.accounts.some((account) => account.username === A.username && account.password === A.password)
  );

  // 导入（一条重复 + 一条新增）
  const importFile = path.join(TEMP_ROOT, 'import-accounts.json');
  fs.writeFileSync(
    importFile,
    JSON.stringify(
      {
        app: 'zjuamin',
        schemaVersion: 1,
        accounts: [
          { label: '导入账号', username: '3200100003', password: 'Import!2024' },
          { label: '重复账号', username: A.username, password: A.password }
        ]
      },
      null,
      2
    )
  );
  await cdp.send('DOM.enable', {}, page.sessionId);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, page.sessionId);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#importFile' }, page.sessionId);
  await cdp.send('DOM.setFileInputFiles', { files: [importFile], nodeId }, page.sessionId);
  await evaluate(page, 'document.getElementById("importFile").dispatchEvent(new Event("change", { bubbles: true })); true');
  await waitForEval(
    page,
    'ZJUAM.loadState().then(function(s){ return s.accounts.length; })',
    3,
    10000,
    '导入账户后账户数变为 3'
  );
  state = await storageState(page);
  const importedId = (state.accounts.find((account) => account.username === '3200100003') || {}).id;
  check('导入按学号去重：只新增 1 个账户', state.accounts.length === 3 && Boolean(importedId));

  // 删除导入的账户（confirm 由全局 dialog handler 自动接受）
  await clickBySelector(page, 'button[data-act="delete"][data-id="' + importedId + '"]');
  await waitForEval(
    page,
    'ZJUAM.loadState().then(function(s){ return s.accounts.length; })',
    2,
    8000,
    '删除导入账户后账户数恢复为 2'
  );
  check('删除账户生效', true);

  await setViewport(page, 1000, 1180);
  await screenshot(page, path.join(SCREENSHOT_DIR, 'options.png'));
  await sleep(300);
  check('设置页没有 JS 错误', page.errors.length === 0, page.errors.join(' | '));

  return {
    page,
    accounts: {
      A: { ...A, id: aId, label: newLabel },
      B: { ...B, id: bId }
    }
  };
}

/* ───────────────────────── 弹窗 ───────────────────────── */

async function testPopup(extBaseUrl, accounts) {
  section('弹窗：账户列表与切换');

  const page = await createPage(extBaseUrl + '/popup/popup.html');
  await waitPageLoaded(page);
  await waitForEval(page, 'document.querySelectorAll("#accountSelect option").length', 2, 10000, '弹窗账户下拉');

  const info = await evaluate(
    page,
    '(function(){' +
      '  var select = document.getElementById("accountSelect");' +
      '  return {' +
      '    optionCount: select.options.length,' +
      '    value: select.value,' +
      '    selectedText: select.options[select.selectedIndex] ? select.options[select.selectedIndex].textContent : "",' +
      '    fillText: document.getElementById("fillNow").textContent,' +
      '    version: document.getElementById("versionText").textContent' +
      '  };' +
      '})()'
  );
  check('弹窗列出全部 2 个账户', info.optionCount === 2, info.optionCount);
  check('弹窗默认选中当前账户 B', info.value === accounts.B.id, info.selectedText);
  check('弹窗主按钮文本为「立即填充并登录」', info.fillText === '立即填充并登录', info.fillText);
  check('弹窗显示版本号', /^v\d+\.\d+\.\d+$/.test(info.version), info.version);

  // 在弹窗里切换到账户 A，再切回 B
  await evaluate(
    page,
    '(function(){' +
      '  var select = document.getElementById("accountSelect");' +
      '  var descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");' +
      '  descriptor.set.call(select, ' + JSON.stringify(accounts.A.id) + ');' +
      '  select.dispatchEvent(new Event("change", { bubbles: true }));' +
      '  return true;' +
      '})()'
  );
  await waitForEval(
    page,
    'ZJUAM.loadState().then(function(s){ return s.activeAccountId; })',
    accounts.A.id,
    6000,
    '弹窗切换到账户 A'
  );
  check('可以在弹窗中切换生效账户', true);

  await evaluate(
    page,
    '(function(){' +
      '  var select = document.getElementById("accountSelect");' +
      '  var descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");' +
      '  descriptor.set.call(select, ' + JSON.stringify(accounts.B.id) + ');' +
      '  select.dispatchEvent(new Event("change", { bubbles: true }));' +
      '  return true;' +
      '})()'
  );
  await waitForEval(
    page,
    'ZJUAM.loadState().then(function(s){ return s.activeAccountId; })',
    accounts.B.id,
    6000,
    '弹窗切回账户 B'
  );

  await setViewport(page, 360, 560);
  await screenshot(page, path.join(SCREENSHOT_DIR, 'popup.png'));
  await sleep(300);
  check('弹窗没有 JS 错误', page.errors.length === 0, page.errors.join(' | '));
  await closePage(page);
}

/* ───────────────────────── 登录流程 ───────────────────────── */

async function waitForPostCount(minCount, timeoutMs) {
  await waitFor(() => mock.getState().posts.length >= minCount, timeoutMs || 12000, 150, '登录 POST');
  return mock.getState();
}

async function setSetting(page, patch) {
  await evaluate(
    page,
    '(async function(){' +
      '  var st = await ZJUAM.loadState();' +
      '  var patch = ' + JSON.stringify(patch) + ';' +
      '  Object.keys(patch).forEach(function(key){ st.settings[key] = patch[key]; });' +
      '  await ZJUAM.saveState(st);' +
      '  return true;' +
      '})()'
  );
}

async function testLoginFlows(loginBaseUrl, accounts, optionsPage) {
  const A = accounts.A;
  const B = accounts.B;

  // 1. 自动填充 + 自动提交（当前账户 B）
  section('登录页：自动填充 + 自动提交');
  await mock.reset('success');
  const page1 = await createPage(loginBaseUrl + '/cas/login');
  await waitPageLoaded(page1);
  const state1 = await waitForPostCount(1, 15000);
  check('认证页自动提交：mock CAS 收到 1 次 POST', state1.posts.length === 1, '实际 ' + state1.posts.length);
  const post1 = state1.posts[0] || {};
  check('使用当前生效账户 B 的学号', post1.username === B.username, post1.username);
  check('密码端到端正确（页面 JS 加密后由服务端解码）', post1.decodedPassword === B.password, post1.decodedPassword);
  check('默认未勾选「记住我」', !post1.rememberMe, String(post1.rememberMe));
  check(
    '填充到点击「登录」的间隔很短（< 600ms）',
    typeof post1.clickDelayMs === 'number' && post1.clickDelayMs >= 0 && post1.clickDelayMs < 600,
    post1.clickDelayMs + 'ms'
  );
  await sleep(800);
  check('登录成功后跟随 302 到成功页', mock.getState().successPages >= 1, 'successPages=' + mock.getState().successPages);
  await closePage(page1);

  // 2. 密码错误：不重复提交
  section('登录页：密码错误后不重复提交');
  await mock.reset('error');
  const page2 = await createPage(loginBaseUrl + '/cas/login');
  await waitPageLoaded(page2);
  await waitForPostCount(1, 15000);
  await waitForEval(
    page2,
    '(document.getElementById("zjuamin-toast") || {}).textContent || ""',
    (value) => typeof value === 'string' && value.indexOf('已暂停自动提交') >= 0,
    12000,
    '错误页暂停提示'
  );
  await sleep(3500);
  check('错误页没有再次自动提交（仍为 1 次 POST）', mock.getState().posts.length === 1, '实际 ' + mock.getState().posts.length);

  const errorState = await evaluate(
    page2,
    '(function(){' +
      '  var guardRaw = sessionStorage.getItem("zjuamin.guard.v1");' +
      '  var guard = null;' +
      '  try { guard = JSON.parse(guardRaw); } catch (error) {}' +
      '  return {' +
      '    username: (document.getElementById("username") || {}).value || "",' +
      '    guard: guard,' +
      '    toast: (document.getElementById("zjuamin-toast") || {}).textContent || ""' +
      '  };' +
      '})()'
  );
  check('错误页仍自动填入了当前账户', errorState.username === B.username, errorState.username);
  check('sessionStorage guard 记录 failed>=2', Boolean(errorState.guard) && errorState.guard.failed >= 2, JSON.stringify(errorState.guard));
  check('页面提示「已暂停自动提交」', /已暂停自动提交/.test(errorState.toast), errorState.toast);
  await setViewport(page2, 920, 720);
  await screenshot(page2, path.join(SCREENSHOT_DIR, 'login-error.png'));
  await closePage(page2);

  // 3. 需要验证码：只填充不提交
  section('登录页：需要验证码时只填充');
  await mock.reset('captcha');
  const page3 = await createPage(loginBaseUrl + '/cas/login');
  await waitPageLoaded(page3);
  await waitForEval(
    page3,
    '(document.getElementById("username") || {}).value || ""',
    B.username,
    12000,
    '验证码页自动填充'
  );
  await sleep(2500);
  check('需要验证码时不自动提交（0 次 POST）', mock.getState().posts.length === 0, '实际 ' + mock.getState().posts.length);
  const captchaState = await evaluate(
    page3,
    '(function(){' +
      '  var box = document.getElementById("kaptcha");' +
      '  var password = document.getElementById("password");' +
      '  return {' +
      '    kaptchaDisplay: box ? getComputedStyle(box).display : "missing",' +
      '    password: password ? password.value : "",' +
      '    toast: (document.getElementById("zjuamin-toast") || {}).textContent || ""' +
      '  };' +
      '})()'
  );
  check('验证码框保持可见', captchaState.kaptchaDisplay !== 'none' && captchaState.kaptchaDisplay !== 'missing', captchaState.kaptchaDisplay);
  check('未提交时密码保持明文', captchaState.password === B.password, captchaState.password);
  check('页面提示需要输入验证码', /验证码/.test(captchaState.toast), captchaState.toast);
  await setViewport(page3, 920, 720);
  await screenshot(page3, path.join(SCREENSHOT_DIR, 'login-captcha.png'));
  await closePage(page3);

  // 4. 关闭「自动提交」：只填充不提交
  section('登录页：关闭自动提交 / 关闭自动填充');
  await setSetting(optionsPage, { autoSubmit: false });
  await mock.reset('success');
  const page4 = await createPage(loginBaseUrl + '/cas/login');
  await waitPageLoaded(page4);
  await waitForEval(
    page4,
    '(document.getElementById("username") || {}).value || ""',
    B.username,
    12000,
    '关闭自动提交后仍自动填充'
  );
  await sleep(2000);
  check('关闭「自动提交」后 0 次 POST', mock.getState().posts.length === 0, '实际 ' + mock.getState().posts.length);
  const fillOnly = await evaluate(page4, '(document.getElementById("password") || {}).value || ""');
  check('关闭自动提交时密码保持明文', fillOnly === B.password, fillOnly);
  await closePage(page4);

  await setSetting(optionsPage, { autoSubmit: true, autoFill: false });
  await mock.reset('success');
  const page5 = await createPage(loginBaseUrl + '/cas/login');
  await waitPageLoaded(page5);
  await sleep(2500);
  const noFill = await evaluate(page5, '(document.getElementById("username") || {}).value || ""');
  check('关闭「自动填充」时不填表、不提交', noFill === '' && mock.getState().posts.length === 0, noFill);
  await closePage(page5);
  await setSetting(optionsPage, { autoFill: true, autoSubmit: true });

  // 5. 切换生效账户后使用另一个账户
  section('登录页：切换生效账户');
  await evaluate(
    optionsPage,
    '(async function(){ var st = await ZJUAM.loadState(); st.activeAccountId = ' + JSON.stringify(A.id) + '; await ZJUAM.saveState(st); return true; })()'
  );
  await mock.reset('success');
  const page6 = await createPage(loginBaseUrl + '/cas/login');
  await waitPageLoaded(page6);
  const state6 = await waitForPostCount(1, 15000);
  const post6 = state6.posts[0] || {};
  check('切换生效账户后使用账户 A 的学号', post6.username === A.username, post6.username);
  check('账户 A 的密码同样正确', post6.decodedPassword === A.password, post6.decodedPassword);
  await closePage(page6);

  // 恢复：账户 B 为当前
  await evaluate(
    optionsPage,
    '(async function(){ var st = await ZJUAM.loadState(); st.activeAccountId = ' + JSON.stringify(B.id) + '; await ZJUAM.saveState(st); return true; })()'
  );
}

/* ───────────────────────── 清理 ───────────────────────── */

async function cleanup() {
  try {
    if (cdp) {
      try {
        await cdp.send('Browser.close');
      } catch (error) {
        /* ignore */
      }
      cdp.close();
    }
  } catch (error) {
    /* ignore */
  }
  if (edge) {
    await waitExit(edge.child, 8000);
    if (!edge.exited) edge.kill();
  }
  if (mock) {
    try {
      await mock.close();
    } catch (error) {
      /* ignore */
    }
  }
  releaseProfileLock();
  try {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch (error) {
    /* ignore */
  }
}

/* ───────────────────────── 主流程 ───────────────────────── */

async function main() {
  console.log('== ZJUAM-in E2E ==');
  console.log('Edge: ' + EDGE);
  if (!fs.existsSync(EDGE)) throw new Error('找不到 Edge: ' + EDGE);

  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  acquireProfileLock(120000);
  console.log('已获取无头 Edge profile 锁');

  mock = await startMockCasServer();
  console.log('mock CAS: ' + mock.baseUrl);

  const testExt = buildTestExtension();
  console.log('测试扩展: ' + testExt.extDir + '  (id=' + testExt.extensionId + ')');

  edge = await launchEdge(testExt.extDir);
  console.log('Edge 已启动, CDP 端口 ' + edge.port);
  cdp = await CDP.connect(edge.port);
  registerGlobalHandlers();

  const worker = await findExtensionServiceWorker(testExt.extensionId);
  check('MV3 service worker 已注册', Boolean(worker), worker && worker.url);
  const testManifest = JSON.parse(fs.readFileSync(path.join(testExt.extDir, 'manifest.json'), 'utf8'));
  const testPermissions = Array.isArray(testManifest.permissions) ? testManifest.permissions : [];
  check(
    'manifest 权限正确（storage + scripting，未申请 tabs）',
    testPermissions.includes('storage') &&
      testPermissions.includes('scripting') &&
      !testPermissions.includes('tabs'),
    'permissions=' + JSON.stringify(testPermissions)
  );

  const extBaseUrl = 'chrome-extension://' + testExt.extensionId;
  const optionsResult = await testOptionsAndAccounts(extBaseUrl);
  await testPopup(extBaseUrl, optionsResult.accounts);
  await testLoginFlows(mock.baseUrl, optionsResult.accounts, optionsResult.page);

  check('设置页整轮运行无 JS 错误', optionsResult.page.errors.length === 0, optionsResult.page.errors.join(' | '));
  await closePage(optionsResult.page);
}

(async () => {
  try {
    await main();
  } catch (error) {
    failed = true;
    console.error('\nE2E 运行失败:\n' + (error && error.stack ? error.stack : String(error)));
    if (edge && typeof edge.recentStderr === 'function') {
      const stderr = edge.recentStderr();
      if (stderr) console.error('\n--- Edge stderr（尾部）---\n' + stderr);
    }
  } finally {
    await cleanup();
  }

  const passed = results.filter((result) => result.ok).length;
  console.log('\n== 结果: ' + passed + ' / ' + results.length + ' 项通过 ==');
  if (failed) {
    console.log('失败项:');
    for (const result of results) {
      if (!result.ok) console.log('  - ' + result.name + (result.detail ? '  [' + result.detail + ']' : ''));
    }
  }
  process.exit(failed ? 1 : 0);
})();
