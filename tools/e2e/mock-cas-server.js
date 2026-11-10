'use strict';

/**
 * 端到端测试用的 mock CAS 服务器。
 *
 * 复刻 zjuam 登录页的关键结构：form#fm1 / #username / #password / #dl / #kaptcha /
 * #rember / #errormsg，以及「点 #dl → 取公钥 → 把密码反转后 hex 编码写回 #password
 * → form.submit()」的行为。这样可以在不接触真实学校系统的前提下验证扩展。
 *
 * 控制接口：
 *   GET  /__state   → 当前模式、收到的 POST、页面渲染计数
 *   POST /__reset   → {"mode":"success"|"error"|"captcha"}，清空计数并切换模式
 */

const http = require('node:http');
const { URL } = require('node:url');

const PUBLIC_KEY = {
  modulus: 'c7f1f8a2b3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6',
  exponent: '10001'
};

function decodeEncrypted(encrypted) {
  if (!encrypted || typeof encrypted !== 'string') return '';
  return encrypted
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => String.fromCharCode(Number.parseInt(part, 16)))
    .reverse()
    .join('');
}

function renderLoginPage(mode, errorText) {
  const captchaVisible = mode === 'captcha';
  const captchaStyle = captchaVisible ? 'display: block;' : 'display: none;';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>浙江大学统一身份认证</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(160deg, #eaf3ff 0%, #f7faff 55%, #e4eefb 100%);
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif; color: #1b2b41;
  }
  .card {
    width: 400px; padding: 34px 36px 26px; border-radius: 16px; background: #fff;
    box-shadow: 0 18px 48px rgba(18, 60, 120, 0.16); border: 1px solid #e1eaf5;
  }
  .brand { display: flex; gap: 12px; align-items: center; margin-bottom: 22px; }
  .logo {
    width: 46px; height: 46px; border-radius: 12px; flex: 0 0 auto;
    background: linear-gradient(135deg, #1b74cf, #0b4f9c); color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 15px; letter-spacing: 0.5px;
  }
  h1 { margin: 0; font-size: 18px; color: #0b4f9c; letter-spacing: 0.3px; }
  .sub { margin: 3px 0 0; font-size: 11.5px; color: #7a8ca3; }
  .row { margin-bottom: 14px; }
  .row label { display: block; margin-bottom: 5px; font-size: 12px; color: #5d6f85; }
  .row input {
    width: 100%; height: 40px; padding: 0 12px; border: 1px solid #d6e0ec; border-radius: 8px;
    font-size: 14px; font-family: inherit; background: #fbfdff; color: #17283d;
  }
  .row input:focus { outline: none; border-color: #1b74cf; box-shadow: 0 0 0 3px rgba(27,116,207,.14); }
  .remember { display: flex; align-items: center; gap: 7px; font-size: 12px; color: #5d6f85; margin: 2px 0 16px; }
  .remember input { accent-color: #1b74cf; }
  .login-btn {
    width: 100%; height: 42px; border: 0; border-radius: 8px; cursor: pointer;
    background: linear-gradient(135deg, #125aa8, #1b74cf); color: #fff;
    font-size: 15px; font-weight: 600; letter-spacing: 4px; font-family: inherit;
    box-shadow: 0 6px 16px rgba(18,90,168,.28);
  }
  .error { min-height: 18px; margin: 12px 0 0; color: #b02828; font-size: 12px; text-align: center; }
  .foot { margin: 14px 0 0; padding-top: 12px; border-top: 1px dashed #e6ecf4; color: #9aa8b9; font-size: 10.5px; text-align: center; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="logo">ZJU</div>
      <div>
        <h1>浙江大学统一身份认证</h1>
        <p class="sub">ZJUAMin 端到端测试 · mock CAS</p>
      </div>
    </div>
    <form id="fm1" action="/cas/login" method="post" autocomplete="off">
      <div class="row"><label for="username">学号 / 工号</label><input id="username" name="username" type="text" autocomplete="username"></div>
      <div class="row"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password"></div>
      <div id="kaptcha" class="row" style="${captchaStyle}"><label for="authcode">验证码</label><input id="authcode" name="authcode" type="text" autocomplete="off"></div>
      <label class="remember"><input id="rember" type="checkbox" name="rememberMe"> 记住我</label>
      <button id="dl" type="button" class="login-btn">登 录</button>
      <p id="errormsg" class="error">${errorText || ''}</p>
      <input type="hidden" name="execution" value="e1s1">
      <input type="hidden" name="_eventId" value="submit">
    </form>
    <p class="foot">mock server · mode=${mode}</p>
  </div>
<script>
(function () {
  'use strict';
  // 记录「密码被填入」到「点击登录」的间隔，供 E2E 断言自动提交是否够快。
  var timing = { passwordAt: 0, clickAt: 0 };
  function mockEncrypt(value) {
    var reversed = String(value).split('').reverse().join('');
    var parts = [];
    for (var i = 0; i < reversed.length; i += 1) {
      parts.push(reversed.charCodeAt(i).toString(16));
    }
    return parts.join(' ');
  }
  function isVisible(id) {
    var el = document.getElementById(id);
    if (!el) return false;
    var style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
  function setError(message) {
    document.getElementById('errormsg').textContent = message;
  }
  function checkForm() {
    var username = document.getElementById('username').value;
    var password = document.getElementById('password').value;
    if (!username) { setError('请输入学号 / 工号'); return; }
    if (!password) { setError('请输入密码'); return; }
    if (isVisible('kaptcha') && !document.getElementById('authcode').value) { setError('请输入验证码'); return; }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/cas/v2/getPubKey', true);
    xhr.onload = function () {
      document.getElementById('password').value = mockEncrypt(password);
      var form = document.getElementById('fm1');
      var clickDelay = document.createElement('input');
      clickDelay.type = 'hidden';
      clickDelay.name = '__clickDelay';
      clickDelay.value = String(timing.passwordAt && timing.clickAt ? timing.clickAt - timing.passwordAt : -1);
      form.appendChild(clickDelay);
      form.submit();
    };
    xhr.send();
  }
  document.getElementById('dl').addEventListener('click', checkForm);
  document.getElementById('dl').addEventListener('click', function () {
    timing.clickAt = Date.now();
  });
  var passwordField = document.getElementById('password');
  if (passwordField) {
    passwordField.addEventListener('input', function () {
      timing.passwordAt = Date.now();
    });
  }
  // 复刻真实 login.js：在用户名输入时清空错误提示（这正是「先填表再读错误」会踩的坑）
  var usernameInput = document.getElementById('username');
  if (usernameInput) {
    usernameInput.addEventListener('input', function () {
      var errorNode = document.getElementById('errormsg');
      if (errorNode) errorNode.textContent = '';
    });
  }
  window.__mockCheckForm = checkForm;
})();
</script>
</body>
</html>`;
}

function renderSuccessPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>登录成功</title></head>
<body style="font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; padding: 48px;">
  <h1 id="ok" style="color: #17724a;">登录成功</h1>
  <p>mock CAS：扩展自动填充并提交成功。</p>
</body>
</html>`;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > (limit || 1024 * 1024)) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function startMockCasServer() {
  const state = {
    mode: 'success',
    posts: [],
    loginPages: 0,
    successPages: 0,
    startedAt: Date.now()
  };

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      try {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('mock server error: ' + error.message);
      } catch (ignored) {
        /* ignore */
      }
    });
  });

  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  function send(res, status, headers, body) {
    res.writeHead(status, Object.assign({ 'cache-control': 'no-store' }, headers));
    res.end(body);
  }

  function getState() {
    return {
      mode: state.mode,
      posts: state.posts.slice(),
      loginPages: state.loginPages,
      successPages: state.successPages
    };
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/cas/login') {
      state.loginPages += 1;
      const mode = state.mode === 'captcha' ? 'captcha' : 'normal';
      return send(res, 200, { 'content-type': 'text/html; charset=utf-8' }, renderLoginPage(mode, ''));
    }

    if (req.method === 'POST' && pathname === '/cas/login') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const encrypted = params.get('password') || '';
      const rawClickDelay = params.get('__clickDelay');
      state.posts.push({
        username: params.get('username') || '',
        encrypted,
        decodedPassword: decodeEncrypted(encrypted),
        rememberMe: params.get('rememberMe'),
        authcode: params.get('authcode') || '',
        clickDelayMs: rawClickDelay === null ? null : Number(rawClickDelay),
        mode: state.mode,
        at: Date.now()
      });
      if (state.mode === 'success') {
        res.writeHead(302, { location: '/success', 'cache-control': 'no-store' });
        return res.end();
      }
      return send(
        res,
        200,
        { 'content-type': 'text/html; charset=utf-8' },
        renderLoginPage('error', '用户名或密码错误，请重试')
      );
    }

    if (req.method === 'GET' && pathname === '/success') {
      state.successPages += 1;
      return send(res, 200, { 'content-type': 'text/html; charset=utf-8' }, renderSuccessPage());
    }

    if (req.method === 'GET' && pathname === '/cas/v2/getPubKey') {
      return send(res, 200, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(PUBLIC_KEY));
    }

    if (req.method === 'GET' && pathname === '/__state') {
      return send(res, 200, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(getState()));
    }

    if (req.method === 'POST' && pathname === '/__reset') {
      const body = await readBody(req);
      let mode = 'success';
      try {
        const parsed = JSON.parse(body || '{}');
        if (parsed && typeof parsed.mode === 'string') mode = parsed.mode;
      } catch (error) {
        /* 默认 success */
      }
      state.mode = mode;
      state.posts = [];
      state.loginPages = 0;
      state.successPages = 0;
      return send(res, 200, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: true, mode }));
    }

    if (pathname === '/favicon.ico') {
      return send(res, 204, {}, '');
    }

    return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found: ' + pathname);
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address.port;
      resolve({
        port,
        baseUrl: 'http://127.0.0.1:' + port,
        getState,
        async reset(mode) {
          state.mode = mode || 'success';
          state.posts = [];
          state.loginPages = 0;
          state.successPages = 0;
        },
        async close() {
          for (const socket of sockets) socket.destroy();
          await new Promise((done) => server.close(done));
        }
      });
    });
  });
}

module.exports = { startMockCasServer, decodeEncrypted };
