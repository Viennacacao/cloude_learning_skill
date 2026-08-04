#!/usr/bin/env node
/**
 * 抓文档类课程的所有网络请求，定位"学习进度" API
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);

const PROFILE_DIR = path.join(__dirname, '..', 'runtime-logs', `chrome-profile-netdump-${Date.now()}`);
fs.mkdirSync(PROFILE_DIR, { recursive: true });

(async () => {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    userDataDir: PROFILE_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  // 抓所有 XHR/fetch
  const xhrs = [];
  page.on('request', req => {
    if (['xhr', 'fetch'].includes(req.resourceType())) {
      xhrs.push({
        ts: Date.now(),
        method: req.method(),
        url: req.url(),
        postData: req.postData()?.substring(0, 5000),
      });
    }
  });
  page.on('response', async resp => {
    if (['xhr', 'fetch'].includes(resp.request().resourceType())) {
      const req = resp.request();
      try {
        const body = await resp.text();
        const item = xhrs.find(x => x.url === req.url() && !x.status);
        if (item) {
          item.status = resp.status();
          item.body = body.substring(0, 5000);
        }
      } catch (e) {}
    }
  });

  // Login
  log('=== 登录 ===');
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
  log('登录完成');

  // 清空登录期的 XHR 记录
  xhrs.length = 0;
  log('开始抓课程页 XHR...');

  // 打开"党员网络行为"课程
  const COURSE_ID = '66097d0e408b4956b509e8cc69becbaa';
  const url = `https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId=${COURSE_ID}`;
  log(`打开课程: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(8000);

  // 抓 30 秒
  log('抓 30 秒网络请求...');
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (i % 5 === 0) log(`  ${i}s`);
  }

  // 筛选 + 输出
  const interesting = xhrs.filter(x => {
    const u = x.url.toLowerCase();
    return u.includes('progress') || u.includes('study') || u.includes('time') ||
           u.includes('learn') || u.includes('record') || u.includes('track') ||
           u.includes('chapter') || u.includes('course') || u.includes('heartbeat');
  });

  log(`\n=== 抓到 ${xhrs.length} 个 XHR/fetch ===`);
  log(`其中 ${interesting.length} 个含关键关键词\n`);

  interesting.forEach((x, i) => {
    log(`[${i + 1}] ${x.method} ${x.url}`);
    if (x.postData) log(`    POST: ${x.postData.substring(0, 100)}`);
    if (x.status) log(`    STATUS: ${x.status}`);
    if (x.body) log(`    RESP: ${x.body.substring(0, 200)}`);
    log('');
  });

  // 保存到文件
  fs.writeFileSync(
    path.join(__dirname, '..', 'runtime-logs', `netdump-${Date.now()}.json`),
    JSON.stringify(xhrs, null, 2)
  );
  log(`完整数据保存到 netdump-*.json`);

  log('保留 30s');
  await sleep(30000);
  await browser.close();
})();
