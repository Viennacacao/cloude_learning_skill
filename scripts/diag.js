#!/usr/bin/env node
const puppeteer = require('puppeteer-core');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    userDataDir: path.join(__dirname, '..', 'runtime-logs', 'chrome-profile-diag'),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  // login first
  await page.goto('https://v4.21tb.com/login/login.init.do', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#corpCode', { timeout: 15000 });
  await page.type('#corpCode', 'lscb');
  await page.type('#loginName', '006627');
  await page.type('#swInput', 'Lwm006627');
  await page.click('.login-btn');
  await new Promise(r => setTimeout(r, 5000));

  // go to course
  await page.goto('https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId=bbc93f46a9b4450b81b06f65bfc8e05e', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 8000));

  // check for key elements
  const info = await page.evaluate(() => {
    const result = {};
    result.chapterContainer = !!document.querySelector('.chapter-container');
    result.learningContainer = !!document.querySelector('.learning-container');
    result.sectionList = !!document.querySelector('.section-list');
    result.catalogueWrap = !!document.querySelector('.catalogue-wrap');
    result.elRate = !!document.querySelector('.el-rate');
    result.videoTag = !!document.querySelector('video');
    result.aliplayer = !!document.querySelector('#aliplayer');
    result.allDivs = document.querySelectorAll('div[class*="course"], div[class*="play"], div[class*="learn"], div[class*="video"]').length;
    
    // Try to find Vue component data
    const chapterEl = document.querySelector('.chapter-container');
    if (chapterEl && chapterEl.__vue__) {
      const vm = chapterEl.__vue__;
      result.vueData = vm.$data ? Object.keys(vm.$data).join(',') : 'no $data';
    }
    
    // Check page title
    result.title = document.title;
    result.url = location.href;
    
    return result;
  });
  
  console.log(JSON.stringify(info, null, 2));
  await new Promise(r => setTimeout(r, 2000));
  await browser.close();
})();
