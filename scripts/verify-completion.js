#!/usr/bin/env node
/**
 * 验证 21tb 平台课程是否真的标记为完成
 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    userDataDir: path.join(__dirname, '..', 'runtime-logs', `chrome-profile-verify-${Date.now()}`),
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

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

  const COURSE_CENTER_URL = 'https://v4.21tb.com/els/html/index.parser.do?id=NEW_COURSE_CENTER&current_app_id=8a80810f5ab29060015ad1906d0b3811';
  await page.goto(COURSE_CENTER_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(8000);

  // 找"我的课程"链接
  await page.evaluate(() => {
    const links = document.querySelectorAll('a');
    for (const link of links) {
      if (link.textContent.trim() === '我的课程' || link.textContent.includes('我的课程')) {
        link.click();
        return true;
      }
    }
    return false;
  });
  await sleep(5000);
  await page.screenshot({ path: path.join(__dirname, '..', 'runtime-logs', 'verify-21tb.png') });

  const courses = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.nc-mycourse-card')).map(card => {
      const link = card.querySelector('a.goStudy');
      const titleEl = card.querySelector('h3');
      const fullText = card.textContent.replace(/\s+/g, ' ').trim();
      let progress = '';
      const rows = card.querySelectorAll('.mycourse-row');
      for (const row of rows) {
        if (row.textContent.includes('学习进度') || row.textContent.includes('Progress')) {
          progress = row.textContent.split(/[:：]/)[1]?.trim() || '';
          break;
        }
      }
      return {
        title: titleEl?.textContent?.trim() || '',
        progress,
        isFinished: fullText.includes('Finish') || fullText.includes('已完成') || fullText.includes('完成'),
        fullText: fullText.substring(0, 200),
      };
    });
  });

  console.log('=== 当前课表状态 ===');
  courses.forEach(c => {
    console.log(`[${c.isFinished ? '✓' : ' '}] ${c.title} | ${c.progress}`);
  });

  await browser.close();
})();
