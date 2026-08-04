#!/usr/bin/env node
/**
 * 最小化 dump：评估页所有按钮 + 评分状态 + 文本域值
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
    userDataDir: path.join(__dirname, '..', 'runtime-logs', `chrome-profile-eval-${Date.now()}`),
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

  // Open 党员网络行为 course
  const COURSE_ID = '66097d0e408b4956b509e8cc69becbaa';
  const url = `https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId=${COURSE_ID}`;
  log(`打开课程: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(6000);

  // Click "课程评估" step directly
  log('点击"课程评估"步骤...');
  await page.evaluate(() => {
    const labels = document.querySelectorAll('.steps-item-label.is-canenter');
    for (const label of labels) {
      if ((label.textContent || '').trim().includes('课程评估')) {
        label.click();
        return;
      }
    }
  });
  await sleep(5000);
  await page.screenshot({ path: path.join(__dirname, '..', 'runtime-logs', 'dump-eval-page.png') });

  // Dump eval page structure
  const dump = await page.evaluate(() => {
    const allBtns = Array.from(document.querySelectorAll('button, .el-button, .ant-btn, a.btn, [class*="btn"]'));
    const btns = allBtns.map(b => ({
      tag: b.tagName,
      text: b.textContent.replace(/\s+/g, ' ').trim().substring(0, 30),
      cls: (b.className || '').substring(0, 80),
      visible: b.offsetParent !== null,
      disabled: b.disabled,
      hasOnClick: !!b.onclick,
    })).filter(b => b.visible);

    const rates = document.querySelectorAll('.el-rate, .ant-rate');
    const rateInfo = Array.from(rates).map(r => ({
      cls: r.className,
      stars: r.querySelectorAll('.el-rate__item, .ant-rate-star, [class*="rate__item"], [class*="rate-star"]').length,
      selected: r.querySelectorAll('.el-rate__icon--selected, .is-active, [class*="selected"], [class*="active"]').length,
    }));

    const textareas = Array.from(document.querySelectorAll('textarea')).map(t => ({
      visible: t.offsetParent !== null,
      val: t.value.substring(0, 30),
      placeholder: t.placeholder,
    })).filter(t => t.visible);

    return {
      url: location.href,
      title: document.title,
      btns,
      rateInfo,
      textareas,
      bodyText: (document.body.innerText || '').substring(0, 1000),
    };
  });

  console.log(JSON.stringify(dump, null, 2));
  log('保留 60s');
  await sleep(60000);
  await browser.close();
})();
