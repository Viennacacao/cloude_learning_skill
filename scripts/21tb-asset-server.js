#!/usr/bin/env node
/**
 * Browser-only 资源服务（给 Agent 内置浏览器注入用）
 *
 * 目的：
 * - 不依赖 Puppeteer/浏览器下载
 * - 将 helper/eval-auto 以 URL 方式提供给“内置浏览器”加载，避免把超长脚本通过 evaluate 传输
 *
 * 用法：
 *   node scripts/21tb-asset-server.js
 *
 * 环境变量：
 *   TB_ASSET_SERVER_HOST=127.0.0.1
 *   TB_ASSET_SERVER_PORT=3210
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.TB_ASSET_SERVER_HOST || '127.0.0.1';
const PORT = Number(process.env.TB_ASSET_SERVER_PORT) || 3210;

const ROOT = path.join(__dirname, '..');
const HELPER_FILE = path.join(ROOT, '21tb-video-helper.user.js');
const EVAL_AUTO_FILE = path.join(__dirname, '21tb-evaluation-auto.js');

function stripUserscriptHeader(raw) {
  return raw.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/m, '').trim();
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendJs(res, js) {
  send(res, 200, js, { 'Content-Type': 'application/javascript; charset=utf-8' });
}

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return null;
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  if (p === '/' || p === '/health') {
    return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  if (p === '/helper.js') {
    const raw = safeRead(HELPER_FILE);
    if (!raw) return send(res, 500, `read fail: ${HELPER_FILE}`, { 'Content-Type': 'text/plain; charset=utf-8' });
    return sendJs(res, stripUserscriptHeader(raw));
  }

  if (p === '/eval-auto.js') {
    const raw = safeRead(EVAL_AUTO_FILE);
    if (!raw) return send(res, 500, `read fail: ${EVAL_AUTO_FILE}`, { 'Content-Type': 'text/plain; charset=utf-8' });
    return sendJs(res, raw);
  }

  if (p === '/bootstrap.js') {
    // 一个很小的 bootstrap，负责把 helper/eval 注入到页面（由页面先设置 window.__TBH_EMBED_CONFIG__）
    const js = `
(() => {
  const cfg = window.__TBH_EMBED_CONFIG__ || {};
  const base = cfg.assetBaseUrl || 'http://${HOST}:${PORT}';
  const load = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error('load failed: ' + src));
    (document.head || document.documentElement).appendChild(s);
  });

  const main = async () => {
    if (window.__TBH_EMBED_SCRIPT_INJECTED__) return;
    window.__TBH_EMBED_SCRIPT_INJECTED__ = true;
    await load(base + '/helper.js');
    if (cfg.autoEval) {
      await load(base + '/eval-auto.js');
    }
  };
  main().catch(() => {});
})();
`.trim();
    return sendJs(res, js);
  }

  return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[21tb-asset-server] listening on http://${HOST}:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[21tb-asset-server] endpoints: /helper.js /eval-auto.js /bootstrap.js /health`);
});

