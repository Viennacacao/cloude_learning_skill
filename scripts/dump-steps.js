#!/usr/bin/env node
/**
 * 最小化：登录 → 打开内控管理课程（已完成，安全）→ dump 步骤条 DOM
 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);

(async () => {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    userDataDir: path.join(__dirname, '..', 'runtime-logs', `chrome-profile-dom-${Date.now()}`),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  // Login
  await page.goto('https://v4.21tb.com/login/login.init.do', { waitUntil: 'networkidle2' });
  await sleep(3000);
  await page.evaluate(() => {
    if (typeof noErwei === 'function') noErwei();
    if (typeof changeWay === 'function') changeWay(1, document.getElementById('login-password'));
  });
  await sleep(1000);
  await page.evaluate((e, u, p) => {
    const setVal = (sel, v) => {
      const el = document.querySelector(sel);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal('#corpCode', e); setVal('#loginName', u); setVal('#swInput', p);
  }, process.env.TB_ENTERPRISE_ID, process.env.TB_USER, process.env.TB_PASS);
  await page.click('.login-btn');
  await sleep(5000);
  await page.evaluate(() => {
    document.querySelectorAll('button, .el-button, .ant-btn').forEach(b => {
      if (['确定', '确 定', '继续登录'].includes(b.textContent.trim())) b.click();
    });
  });
  await sleep(2000);

  // Open a course (use 内控管理, already completed, safe)
  const COURSE_ID = 'bbc93f46a9b4450b81b06f65bfc8e05e';
  const url = `https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId=${COURSE_ID}`;
  log(`打开课程: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(8000);

  // 截图 + 验证登录
  await page.screenshot({ path: path.join(__dirname, '..', 'runtime-logs', 'dump-after-open.png') });
  const loginCheck = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodyLen: document.body.innerText.length,
    bodyStart: document.body.innerText.substring(0, 300),
  }));
  log(`登录检查: ${JSON.stringify(loginCheck)}`);

  // Dump steps area
  const dump = await page.evaluate(() => {
    // 找所有疑似 step 的元素
    const candidates = [
      ...document.querySelectorAll('.el-step'),
      ...document.querySelectorAll('.el-steps__item'),
      ...document.querySelectorAll('.steps-item'),
      ...document.querySelectorAll('[class*="step"]'),
    ];
    const all = Array.from(new Set(candidates));
    const items = all.map(el => ({
      tag: el.tagName,
      class: el.className,
      text: el.textContent.replace(/\s+/g, ' ').trim().substring(0, 50),
      hasIsCanenter: el.classList.contains('is-canenter'),
      hasIsProcess: el.classList.contains('is-process'),
      hasIsFinish: el.classList.contains('is-finish'),
      hasIsWait: el.classList.contains('is-wait'),
      cursor: getComputedStyle(el).cursor,
    })).filter(i => i.text.includes('课程') || i.text.includes('评估') || i.text.includes('学习'));

    return {
      url: location.href,
      title: document.title,
      stepCandidates: items,
      evalTexts: Array.from(document.querySelectorAll('*')).filter(el => {
        const t = (el.textContent || '').trim();
        return t === '课程评估' && el.children.length === 0;
      }).map(el => ({ tag: el.tagName, class: el.className, parent: el.parentElement?.className })),
    };
  });

  console.log(JSON.stringify(dump, null, 2));
  log('保留 30s');
  await sleep(30000);
  await browser.close();
})();
