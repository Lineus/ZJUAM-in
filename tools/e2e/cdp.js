'use strict';

/**
 * 极简 Chrome DevTools Protocol 客户端（零依赖，Node 22+ 自带 WebSocket/fetch）。
 * 支持 browser 级连接 + Target.attachToTarget(flatten) 得到的 sessionId。
 */
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  static async connect(port) {
    const res = await fetch('http://127.0.0.1:' + port + '/json/version');
    if (!res.ok) throw new Error('CDP /json/version HTTP ' + res.status);
    const info = await res.json();
    if (!info.webSocketDebuggerUrl) throw new Error('CDP 没有返回 webSocketDebuggerUrl');
    const client = new CDP(info.webSocketDebuggerUrl);
    await client.open();
    return client;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (event) => reject(new Error('CDP WebSocket 连接失败: ' + (event.message || this.wsUrl)));
      ws.onclose = () => {
        this.closed = true;
        for (const entry of this.pending.values()) {
          entry.reject(new Error('CDP 连接已关闭: ' + entry.method));
        }
        this.pending.clear();
      };
      ws.onmessage = (event) => {
        this._onMessage(event.data).catch((error) => {
          // 解析失败只影响该条消息，不影响后续测试
          console.error('[cdp] 处理消息失败:', error.message);
        });
      };
    });
  }

  async _onMessage(raw) {
    let text;
    if (typeof raw === 'string') {
      text = raw;
    } else if (raw instanceof ArrayBuffer) {
      text = Buffer.from(raw).toString('utf8');
    } else if (raw && typeof raw.arrayBuffer === 'function') {
      text = Buffer.from(await raw.arrayBuffer()).toString('utf8');
    } else {
      text = String(raw);
    }

    const message = JSON.parse(text);
    if (message.id) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(
          (message.error.message || 'CDP 错误') + ' (' + entry.method + ', code ' + message.error.code + ')'
        );
        error.cdpError = message.error;
        entry.reject(error);
      } else {
        entry.resolve(message.result || {});
      }
      return;
    }

    const handlers = this.listeners.get(message.method);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(message.params || {}, message.sessionId || null);
        } catch (error) {
          console.error('[cdp] 事件处理器异常 (' + message.method + '):', error.message);
        }
      }
    }
  }

  send(method, params, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = ++this.nextId;
    const message = { id, method, params: params || {} };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => {
      const set = this.listeners.get(method);
      if (set) set.delete(handler);
    };
  }

  waitForEvent(method, predicate, timeoutMs, sessionId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('等待事件超时: ' + method + (sessionId ? ' [session]' : '')));
      }, timeoutMs);

      const off = this.on(method, (params, eventSessionId) => {
        if (sessionId && eventSessionId !== sessionId) return;
        let matched = true;
        if (predicate) {
          try {
            matched = Boolean(predicate(params));
          } catch (error) {
            matched = false;
          }
        }
        if (!matched) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        /* ignore */
      }
    }
  }
}

module.exports = { CDP };
