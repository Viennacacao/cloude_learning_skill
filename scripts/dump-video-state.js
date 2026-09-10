#!/usr/bin/env node
// 诊断：21tb 视频播放器状态（v2，抗 detached frame）
const puppeteer = require('puppeteer-core');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOGS_DIR = path.join(__dirname, '..', 'runtime-logs');
const COURSE_ID = '62ea1fea17536baf18a738265220c23a';

(async () => {
  const userDataDir = path.join(LOGS_DIR, 'chrome-profile');
  ['SingletonLock','SingletonSocket','SingletonCookie','LOCK'].forEach(f => {
    try { require('fs').unlinkSync(path.join(userDataDir, f)); } catch {}
  });
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false, userDataDir,
    args: ['--no-sandbox','--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  try {
    await page.goto('https://v4.21tb.com/login/login.init.do', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    await page.evaluate(() => {
      if (typeof noErwei === 'function') noErwei();
      if (typeof changeWay === 'function') changeWay(1, document.getElementById('login-password'));
    });
    await sleep(1000);
    await page.evaluate((e,u,p) => {
      const setVal = (s,v) => { const el=document.querySelector(s); if(!el)return; const st=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; st.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); };
      setVal('#corpCode',e); setVal('#loginName',u); setVal('#swInput',p);
    }, process.env.TB_ENTERPRISE_ID, process.env.TB_USER, process.env.TB_PASS);
    await page.click('.login-btn');
    await sleep(5000);
    console.log('登录OK, 打开课程...');
    await page.goto(`https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId=${COURSE_ID}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(12000);

    const readVideos = async (label) => {
      console.log(`\n===== ${label} =====`);
      for (const frame of page.frames()) {
        try {
          const info = await frame.evaluate(() => {
            const vids = Array.from(document.querySelectorAll('video')).map((v,i) => ({
              i,
              paused: v.paused,
              ended: v.ended,
              rate: v.playbackRate,
              t: Number(v.currentTime||0).toFixed(1),
              d: Number(v.duration||0).toFixed(1),
              ready: v.readyState,
              net: v.networkState,
              vis: v.offsetParent !== null,
              w: v.clientWidth,
              src: (v.src||v.querySelector('source')?.src||'').substring(0,60),
            }));
            return { vids };
          });
          if (info.vids.length > 0) {
            console.log(`[frame ${frame.url().substring(0,50)}]`);
            console.log(JSON.stringify(info.vids, null, 2));
          }
        } catch (e) {
          // detached frame，跳过
        }
      }
    };

    await readVideos('初始状态');
    await sleep(4000);
    await readVideos('4秒后');
    await sleep(4000);
    await readVideos('8秒后');

    try {
      await page.screenshot({ path: path.join(LOGS_DIR, 'screenshots', 'video-diag.png') });
      console.log('\n截图保存');
    } catch {}

    await sleep(5000);
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await browser.close();
  }
})();
