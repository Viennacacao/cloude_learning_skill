#!/usr/bin/env node
/**
 * 登录 → 导航到课程 → dump DOM + 截图
 * 用于排查 UI 真实状态
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);

const SHOTS_DIR = path.join(__dirname, '..', 'runtime-logs', 'shots');
const PROFILE_DIR = path.join(__dirname, '..', 'runtime-logs', `chrome-profile-dump-${Date.now()}`);
fs.mkdirSync(SHOTS_DIR, { recursive: true });

async function shot(page, name) {
  const file = path.join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  log(`截图: ${file}`);
}

async function dismissSessionExpiredModal(page) {
  // 检查并点掉"登录已超时"弹窗，可能需要重复多次
  for (let i = 0; i < 5; i++) {
    const hasModal = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return text.includes('登录已超时') || text.includes('请重新登录') || text.includes('账号在其他设备');
    });
    if (!hasModal) return false;
    log(`⚠️  检测到"登录已超时"弹窗，尝试点掉 (第 ${i+1} 次)`);
    await shot(page, `modal-expired-${i}`);
    await page.evaluate(() => {
      document.querySelectorAll('button, .el-button, .ant-btn').forEach(b => {
        const t = b.textContent.trim();
        if (t === '确定' || t === '确 定') b.click();
      });
    });
    await sleep(2000);
  }
  return true;
}

async function login(page) {
  log('=== 登录 ===');
  await page.goto('https://v4.21tb.com/login/login.init.do', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  await shot(page, '01-login-page');

  // 切密码模式
  await page.evaluate(() => {
    if (typeof noErwei === 'function') noErwei();
    if (typeof changeWay === 'function') changeWay(1, document.getElementById('login-password'));
  });
  await sleep(1000);
  await shot(page, '02-password-mode');

  // 填表
  await page.evaluate((e, u, p) => {
    const setVal = (sel, v) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal('#corpCode', e); setVal('#loginName', u); setVal('#swInput', p);
  }, process.env.TB_ENTERPRISE_ID, process.env.TB_USER, process.env.TB_PASS);
  await shot(page, '03-filled');

  await page.click('.login-btn');
  await sleep(5000);
  await shot(page, '04-after-login');

  // 弹窗循环处理
  await dismissSessionExpiredModal(page);
  await sleep(3000);
  await shot(page, '05-after-modal');
}

(async () => {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  log(`Profile: ${PROFILE_DIR}`);

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    userDataDir: PROFILE_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.setViewport({ width: 1280, height: 800 });

  try {
    await login(page);

    // 导航到课程
    const COURSE_ID = '66097d0e408b4956b509e8cc69becbaa';
    const url = `https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId=${COURSE_ID}`;
    log(`=== 打开课程: ${url} ===`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(8000);
    await dismissSessionExpiredModal(page);
    await shot(page, '10-course-page');

    // Dump DOM
    const dump = await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll('button, .el-button, .ant-btn'));
      const btns = allBtns.map(b => ({
        text: b.textContent.trim().substring(0, 30),
        cls: (b.className || '').substring(0, 80),
        visible: b.offsetParent !== null,
        disabled: b.disabled,
      })).filter(b => b.visible && b.text);
      const rates = document.querySelectorAll('.el-rate, .ant-rate').length;
      const textareas = Array.from(document.querySelectorAll('textarea')).map(t => ({
        visible: t.offsetParent !== null,
        val: t.value,
        placeholder: t.placeholder,
      })).filter(t => t.visible);
      const steps = Array.from(document.querySelectorAll('.steps-item, .el-steps__item, [class*="step-item"]')).map(s => ({
        text: s.textContent.trim().substring(0, 50),
        cls: (s.className || '').substring(0, 100),
      }));
      const chapterContainers = document.querySelectorAll('.chapter-container').length;
      const questionList = document.querySelectorAll('.course-test-type-list-item').length;
      const mainText = (document.body.innerText || '').substring(0, 1500);
      return {
        url: location.href,
        title: document.title,
        rates, textareas, btns: btns.slice(0, 30), steps, chapterContainers, questionList,
        mainText,
      };
    });

    fs.writeFileSync(path.join(SHOTS_DIR, 'dom-dump.json'), JSON.stringify(dump, null, 2));
    log(`DOM dump: ${path.join(SHOTS_DIR, 'dom-dump.json')}`);
    log(`URL: ${dump.url}`);
    log(`rates=${dump.rates} textareas=${dump.textareas.length} chapterContainers=${dump.chapterContainers} questionList=${dump.questionList}`);
    log(`steps: ${JSON.stringify(dump.steps)}`);
    log(`visible buttons: ${dump.btns.map(b => b.text).join(' | ')}`);

    // 点击"课程评估"步骤
    log('=== 点击"课程评估"步骤 ===');
    const clicked = await page.evaluate(() => {
      const steps = document.querySelectorAll('.steps-item, .el-steps__item, [class*="step-item"]');
      for (const step of steps) {
        if (step.textContent.includes('课程评估')) {
          (step.querySelector('.is-canenter, .steps-item-label') || step).click();
          return step.textContent.trim();
        }
      }
      return null;
    });
    log(`点击: ${clicked}`);
    await sleep(5000);
    await shot(page, '20-after-step-click');

    // 再 dump 一次
    const dump2 = await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll('button, .el-button, .ant-btn'));
      const btns = allBtns.map(b => ({
        text: b.textContent.trim().substring(0, 30),
        visible: b.offsetParent !== null,
      })).filter(b => b.visible && b.text);
      const rates = document.querySelectorAll('.el-rate, .ant-rate').length;
      const textareas = Array.from(document.querySelectorAll('textarea')).map(t => ({
        visible: t.offsetParent !== null, val: t.value.substring(0, 50),
      })).filter(t => t.visible);
      const steps = Array.from(document.querySelectorAll('.steps-item, .el-steps__item, [class*="step-item"]')).map(s => ({
        text: s.textContent.trim().substring(0, 50),
        cls: (s.className || '').substring(0, 100),
      }));
      return {
        url: location.href,
        rates, textareas, btns: btns.slice(0, 30), steps,
        mainText: (document.body.innerText || '').substring(0, 1500),
      };
    });
    fs.writeFileSync(path.join(SHOTS_DIR, 'dom-dump-after-click.json'), JSON.stringify(dump2, null, 2));
    log(`URL after click: ${dump2.url}`);
    log(`rates=${dump2.rates} textareas=${dump2.textareas.length}`);
    log(`steps: ${JSON.stringify(dump2.steps)}`);
    log(`visible buttons: ${dump2.btns.map(b => b.text).join(' | ')}`);

    log('保持 60 秒');
    await sleep(60000);
  } finally {
    await browser.close();
  }
})();
