const puppeteer = require('puppeteer-core');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    userDataDir: path.join(__dirname, '..', 'runtime-logs', 'chrome-profile-fresh'),
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.goto('https://v4.21tb.com/login/login.init.do', { waitUntil: 'networkidle2' });
  await sleep(2000);
  await page.evaluate(() => {
    if (typeof noErwei === 'function') noErwei();
    if (typeof changeWay === 'function') changeWay(1, document.getElementById('login-password'));
  });
  await sleep(1000);
  await page.type('#corpCode', 'lscb');
  await page.type('#loginName', '006627');
  await page.type('#swInput', 'Lwm006627');
  await page.click('.login-btn');
  await sleep(5000);

  await page.goto('https://v4.21tb.com/els/html/courseCenter/courseCenter.loadStudyTask.do', { waitUntil: 'networkidle2' });
  await sleep(8000);

  // dump all text
  const dump = await page.evaluate(() => {
    return document.body.innerText.slice(0, 5000);
  });
  console.log(dump);
  await browser.close();
})();