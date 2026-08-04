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

  // 抓取所有课程
  const courses = await page.evaluate(() => {
    const result = [];
    document.querySelectorAll('.task-list .course-item, .task-list-item, .course-card, .el-table__row').forEach(item => {
      const text = item.innerText;
      if (text.includes('内控') || text.includes('适当性')) {
        result.push(text.replace(/\s+/g, ' ').trim());
      }
    });
    // 同时检查整页
    if (result.length === 0) {
      const allText = document.body.innerText;
      const lines = allText.split('\n').map(s => s.trim()).filter(s => s.length > 5);
      const filtered = lines.filter(l => l.includes('内控') || l.includes('适当性'));
      return filtered;
    }
    return result;
  });

  console.log(JSON.stringify(courses, null, 2));
  await browser.close();
})();