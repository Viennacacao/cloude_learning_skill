#!/usr/bin/env node
/**
 * 视频倍速诊断（严格按主流程顺序：login → 课表 → 点课表卡 → 课程页）
 * 目的：
 *   1) 查页面上是否有 aliplayer 实例及其官方倍速 API
 *   2) 对比 1x / 4x 下 currentTime 是否真的前进（定位"卡在 274s"根因）
 * 用法: node diag-video.js <课程关键词> [每档观测秒数]
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const SKILL_ROOT = path.join(__dirname, '..');
const LOGS_DIR = path.join(SKILL_ROOT, 'runtime-logs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.error(`[${new Date().toLocaleTimeString()}] ${m}`);

function loadEnv() {
  for (const f of ['.env', '.env.local']) {
    const p = path.join(SKILL_ROOT, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
      const raw = line.trim();
      if (!raw || raw.startsWith('#')) continue;
      const i = raw.indexOf('=');
      if (i <= 0) continue;
      process.env[raw.slice(0, i).trim()] = raw.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

// 探测 aliplayer 实例与可用 API
const PROBE_FN = () => {
  const found = [];
  const names = ['player', 'aliPlayer', 'aliplayer', 'videoPlayer', 'myPlayer', '__player'];
  for (const n of names) {
    try {
      const obj = window[n];
      if (obj && typeof obj === 'object') {
        const api = Object.getOwnPropertyNames(Object.getPrototypeOf(obj) || {});
        found.push({
          name: n,
          hasSetSpeed: typeof obj.setSpeed === 'function',
          hasSeek: typeof obj.seek === 'function',
          hasGetCurrentTime: typeof obj.getCurrentTime === 'function',
          hasGetDuration: typeof obj.getDuration === 'function',
          speedNow: typeof obj.getSpeed === 'function' ? (obj.getSpeed() ?? null) : null,
          curTime: typeof obj.getCurrentTime === 'function' ? (obj.getCurrentTime() ?? null) : null,
          apiSample: api.slice(0, 40),
        });
      }
    } catch {}
  }
  const videos = Array.from(document.querySelectorAll('video')).map(v => ({
    cur: +v.currentTime.toFixed(1), dur: +(v.duration || 0).toFixed(1),
    rate: v.playbackRate, paused: v.paused, rs: v.readyState, ns: v.networkState,
    src: (v.currentSrc || v.src || '').slice(0, 50),
  }));
  return { windowPlayers: found, videos };
};

const SET_RATE_DIRECT = (r) => {
  const all = Array.from(document.querySelectorAll('video'));
  const v = all.find(x => x.offsetParent !== null || x.clientWidth > 0) || all[0];
  if (!v) return false;
  v.muted = true;
  v.playbackRate = r;
  if (v.paused && !v.ended) v.play().catch(() => {});
  return true;
};

const GET_V = () => {
  const all = Array.from(document.querySelectorAll('video'));
  const v = all.find(x => x.offsetParent !== null || x.clientWidth > 0) || all[0];
  if (!v) return null;
  return { cur: +v.currentTime.toFixed(1), dur: +(v.duration || 0).toFixed(1), rate: v.playbackRate, paused: v.paused, rs: v.readyState };
};

(async () => {
  loadEnv();
  const keyword = process.argv[2];
  const observeSec = parseInt(process.argv[3] || '30');
  if (!keyword) { console.error('需要课程关键词'); process.exit(1); }

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    userDataDir: path.join(LOGS_DIR, 'chrome-profile'),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800'],
  });

  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    const E = process.env.TB_ENTERPRISE_ID, U = process.env.TB_USER, P = process.env.TB_PASS;

    // ---- 1. 登录（必须先走 login）----
    log('打开登录页...');
    await page.goto('https://v4.21tb.com/login/login.init.do', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);
    await page.evaluate(() => {
      if (typeof noErwei === 'function') noErwei();
      if (typeof changeWay === 'function') changeWay(1, document.getElementById('login-password'));
    });
    await sleep(1000);
    await page.evaluate((e, u, p) => {
      const setVal = (s, val) => {
        const el = document.querySelector(s);
        if (!el) return;
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      };
      setVal('#corpCode', e); setVal('#loginName', u); setVal('#swInput', p);
    }, E, U, P);
    await page.click('.login-btn');
    await sleep(5000);
    await page.evaluate(() => {
      document.querySelectorAll('button, .ant-btn, .el-button').forEach(b => {
        const t = b.textContent.trim();
        if (t === '确定' || t === '确 定' || t === '继续登录') b.click();
      });
    });
    await sleep(2000);
    log(`登录完成，URL: ${page.url()}`);

    // ---- 2. 课表 ----
    log('导航到课程中心...');
    await page.goto('https://v4.21tb.com/els/html/index.parser.do?id=NEW_COURSE_CENTER&current_app_id=8a80810f5ab29060015ad1906d0b3811',
      { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(6000);
    await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a, span, div')).find(
        el => (el.textContent || '').trim() === 'My Courses' && el.offsetParent !== null);
      if (a) a.click();
    });
    await sleep(5000);

    // ---- 3. 点课表卡（不 goto 课程 URL）----
    const card = await page.evaluate(kw => {
      for (const c of document.querySelectorAll('.nc-mycourse-card')) {
        if ((c.textContent || '').includes(kw)) {
          const link = c.querySelector('a.goStudy');
          if (link) return { found: true, sel: `a.goStudy[data-id="${link.dataset.id}"]`, title: c.textContent.slice(0, 40) };
        }
      }
      return { found: false };
    }, keyword);
    if (!card.found) { log(`课表里没找到「${keyword}」`, 'error'); await browser.close(); return; }
    log(`找到课表卡: ${card.title}`);

    const newTargetPromise = browser.waitForTarget(t => t.opener() === page.target(), { timeout: 15000 }).catch(() => null);
    await page.click(card.sel, { timeout: 5000 });
    log('已点击课表卡');
    const nt = await newTargetPromise;
    let cp = page;
    if (nt) { const p2 = await nt.page(); if (p2) cp = p2; }
    await sleep(8000);
    log(`课程页 URL: ${cp.url()}`);

    // ---- 4. 探测 aliplayer ----
    for (const f of cp.frames()) {
      if (/7moor|moor_chat/i.test(f.url())) continue;
      try {
        const probe = await f.evaluate(PROBE_FN);
        if (probe.windowPlayers.length || probe.videos.length) {
          log(`FRAME ${f.url().slice(0, 60)}`);
          log(`  players: ${JSON.stringify(probe.windowPlayers)}`);
          log(`  videos : ${JSON.stringify(probe.videos)}`);
        }
      } catch {}
    }

    // ---- 5. 对比 1x / 4x 实际前进 ----
    for (const rate of [1, 4]) {
      const ok = await cp.evaluate(SET_RATE_DIRECT, rate).catch(() => false);
      log(`\n===== 设为 ${rate}x (设置成功=${ok}) =====`);
      const start = await cp.evaluate(GET_V).catch(() => null);
      log(`  起点: ${JSON.stringify(start)}`);
      const t0 = Date.now();
      let last = start ? start.cur : 0;
      for (let i = 0; i < Math.ceil(observeSec / 5); i++) {
        await sleep(5000);
        const v = await cp.evaluate(GET_V).catch(() => null);
        if (!v) { log(`  [${i}] 无 video 元素`); continue; }
        const d = v.cur - last; last = v.cur;
        log(`  [${i}] cur=${v.cur}/${v.dur} rate=${v.rate} Δ=${d.toFixed(1)}s rs=${v.rs} paused=${v.paused}`);
      }
      const wall = (Date.now() - t0) / 1000;
      log(`  ⇒ ${rate}x 观测 ${wall.toFixed(0)}s，净前进 ${(last - (start ? start.cur : 0)).toFixed(1)}s`);
    }

    await cp.screenshot({ path: path.join(LOGS_DIR, 'diag-video.png') }).catch(() => {});
    log('截图已保存');
  } catch (e) {
    log(`FATAL ${e.message}`);
  } finally {
    await browser.close();
  }
})();
