#!/usr/bin/env node
const puppeteer = require('puppeteer-core');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    userDataDir: path.join(__dirname, '..', 'runtime-logs', 'chrome-profile-fresh'),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  try {
    await page.goto('https://v4.21tb.com/login/login.init.do', { waitUntil: 'networkidle2' });
    await sleep(3000);
    await page.evaluate(() => {
      if (typeof noErwei === 'function') noErwei();
      if (typeof changeWay === 'function') changeWay(1, document.getElementById('login-password'));
    });
    await sleep(1000);
    await page.waitForSelector('#corpCode', { timeout: 10000 });
    await page.type('#corpCode', 'lscb');
    await page.type('#loginName', '006627');
    await page.type('#swInput', 'Lwm006627');
    await page.click('.login-btn');
    await sleep(5000);
    console.log('登录完成');

    // 直接去课程中心拿当前数据
    await page.goto('https://v4.21tb.com/els/html/courseCenter/courseCenter.loadStudyTask.do', { waitUntil: 'networkidle2' });
    await sleep(5000);

    // 抓取课程数据
    const courses = await page.evaluate(() => {
      const result = [];
      const items = document.querySelectorAll('.course-item, .task-course-item, [class*="course-card"], .course-list-item');
      items.forEach(item => {
        const title = item.querySelector('.course-title, .title, h3, h4')?.textContent?.trim() || '';
        const progress = item.querySelector('.progress, .progress-text, .course-progress')?.textContent?.trim() || '';
        const status = item.querySelector('.course-status, .status')?.textContent?.trim() || '';
        result.push({ title, progress, status });
      });
      return result;
    });
    console.log(JSON.stringify(courses, null, 2));

    await sleep(2000);
    await browser.close();
  } catch (e) {
    console.error('Error:', e.message);
    await browser.close();
  }
})();