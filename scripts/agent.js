#!/usr/bin/env node
/**
 * 21tb 云端学习 - 模块化 Agent 脚本
 *
 * 架构原则：
 * 1. Node.js 是大脑，Puppeteer 是手——所有决策在 Node.js 完成
 * 2. 不注入浏览器端 helper——避免检测逻辑互相打架
 * 3. 状态机驱动——每一步都有明确的进入/退出条件
 * 4. 结构化 JSON 输出——Agent 可监控每一步
 *
 * 用法：
 *   node agent.js login                    # 登录，返回 session 信息
 *   node agent.js courses                  # 获取课表
 *   node agent.js status                   # 获取当前页面状态
 *   node agent.js run <keyword> [--rate 16] # 一键全自动（指定课程关键词）
 *   node agent.js test-ai                  # 验证课后测试 AI 接口
 *   node agent.js screenshot               # 截图保存到 runtime-logs
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// ============================================================
// 工具函数
// ============================================================

const SKILL_ROOT = path.join(__dirname, '..');
const LOGS_DIR = path.join(SKILL_ROOT, 'runtime-logs');
const SCREENSHOT_DIR = path.join(LOGS_DIR, 'screenshots');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg, level = 'info') {
  const time = new Date().toLocaleTimeString();
  const colors = { info: '\x1b[36m', success: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' };
  const c = colors[level] || colors.info;
  console.error(`${c}[${time}] ${msg}${colors.reset}`);
}

function emit(type, data = {}) {
  console.log(JSON.stringify({ type, timestamp: new Date().toISOString(), ...data }));
}

function ensureDirs() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function loadEnv() {
  const envFiles = [path.join(SKILL_ROOT, '.env'), path.join(SKILL_ROOT, '.env.local')];
  for (const envFile of envFiles) {
    if (!fs.existsSync(envFile)) continue;
    const lines = fs.readFileSync(envFile, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const raw = line.trim();
      if (!raw || raw.startsWith('#')) continue;
      const idx = raw.indexOf('=');
      if (idx <= 0) continue;
      const key = raw.slice(0, idx).trim();
      const val = raw.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (envFile.endsWith('.local') || !process.env[key]) process.env[key] = val;
    }
  }
}

// ============================================================
// 浏览器管理
// ============================================================

async function launchBrowser(headless = false) {
  const userDataDir = path.join(LOGS_DIR, 'chrome-profile');
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless,
    userDataDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800'],
  });
  return browser;
}

// 21tb 弹窗："登录已超时或账号在其他设备登录，请重新登录？"
// 任何 goto 后必须调用——否则后续操作会被弹窗遮挡全部失败
async function dismissExpiredModal(page, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const has = await page.evaluate(() => {
      const t = document.body?.innerText || '';
      return /登录已超时|请重新登录|账号在其他设备|在其他设备登录/.test(t);
    });
    if (!has) return false;
    log(`⚠️  检测到登录超时弹窗（第 ${i + 1} 次），点"确定"...`, 'warn');
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button, .el-button, .ant-btn, .el-button--primary');
      for (const b of btns) {
        const t = (b.textContent || '').trim();
        if (t === '确定' || t === '确 定' || t === '重新登录') {
          b.click();
          return;
        }
      }
    });
    await sleep(2000);
  }
  return true; // 出现过弹窗
}

async function getOrCreatePage(browser) {
  const pages = await browser.pages();
  return pages[0] || await browser.newPage();
}

// 文档课专用：注入 32x 加速 hook（在 runAll 探测到文档课后调用）
async function installDocSpeedupHook(page) {
  if (page.__TBH_DOC_HOOK_INSTALLED__) return;
  page.__TBH_DOC_HOOK_INSTALLED__ = true;
  const installer = () => {
    if (window.__TBH_DOC_HOOK__) return;
    window.__TBH_DOC_HOOK__ = true;
    const origSetInterval = window.setInterval;
    window.setInterval = function(fn, ms, ...args) {
      if (typeof ms === 'number' && ms >= 1000) {
        ms = Math.max(31, Math.floor(ms / 32));
      }
      return origSetInterval.call(this, fn, ms, ...args);
    };
    const origSetTimeout = window.setTimeout;
    window.setTimeout = function(fn, ms, ...args) {
      if (typeof ms === 'number' && ms >= 1000 && ms <= 60000) {
        ms = Math.max(31, Math.floor(ms / 32));
      }
      return origSetTimeout.call(this, fn, ms, ...args);
    };
    console.log('[doc-speedup] 32x hook installed');
  };
  // 后续 document 仍自动安装；当前课程页则在 SPA 初始化完成后安装，避免破坏首屏启动。
  await page.evaluateOnNewDocument(installer);
  await page.evaluate(installer);
}

// ============================================================
// 1. 登录
// ============================================================

async function login() {
  loadEnv();
  const enterprise = process.env.TB_ENTERPRISE_ID || '';
  const user = process.env.TB_USER || '';
  const pass = process.env.TB_PASS || '';

  if (!enterprise || !user || !pass) {
    emit('error', { message: 'Missing credentials. Set TB_ENTERPRISE_ID, TB_USER, TB_PASS in .env' });
    process.exit(1);
  }

  log('启动浏览器...');
  const browser = await launchBrowser(false);
  const page = await getOrCreatePage(browser);

  log('打开登录页...');
  await page.goto('https://v4.21tb.com/login/login.init.do', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);

  // 切换到密码登录模式——优先点 UI 元素，回退到老函数
  log('切换到密码登录模式...');
  let switched = false;
  for (let i = 0; i < 5; i++) {
    const corpEl = await page.$('#corpCode');
    if (corpEl && await corpEl.boundingBox()) {
      switched = true;
      break;
    }
    const clicked = await page.evaluate(() => {
      const targets = ['密码登录在这里', '密码登录', '账号密码登录', '切换到密码登录'];
      // 只匹配叶子节点（textContent 完全等于目标且无子元素）
      const all = Array.from(document.querySelectorAll('a, button, span, li, p, [class*="tab"], [class*="switch"]'));
      for (const el of all) {
        const t = (el.textContent || '').trim();
        if (targets.includes(t) && el.children.length === 0) {
          el.click();
          return { ok: true, tag: el.tagName, text: t };
        }
      }
      return { ok: false };
    });
    if (clicked.ok) {
      log(`点击了"${clicked.text}" (${clicked.tag})`, 'info');
      await sleep(1500);
    } else {
      const fallback = await page.evaluate(() => {
        if (typeof noErwei === 'function') { noErwei(); return 'noErwei'; }
        if (typeof changeWay === 'function') { changeWay(1, document.getElementById('login-password')); return 'changeWay'; }
        return null;
      });
      if (!fallback) {
        log('找不到密码登录入口，截图诊断', 'error');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `no-password-entry-${Date.now()}.png`) });
        break;
      }
      await sleep(1500);
    }
  }
  if (!switched) {
    log('未切到密码模式', 'error');
  }

  // 填写表单
  log(`填写企业ID: ${enterprise}`);
  await page.evaluate((e, u, p) => {
    const setVal = (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) return;
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      if (window.$) $(el).val(value);
    };
    setVal('#corpCode', e);
    setVal('#loginName', u);
    setVal('#swInput', p);
  }, enterprise, user, pass);

  // 点击登录
  log('点击登录按钮...');
  await page.click('.login-btn');
  await sleep(5000);

  // 处理确认弹窗
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button, .ant-btn, .el-button');
    btns.forEach(b => {
      const t = b.textContent.trim();
      if (t === '确定' || t === '确 定' || t === '继续登录') b.click();
    });
  });
  await sleep(2000);

  // 检查登录状态
  const url = page.url();
  const loggedIn = !url.includes('login');
  if (!loggedIn) {
    emit('error', { message: 'Login failed', url });
    await browser.close();
    process.exit(1);
  }

  log('✅ 登录成功', 'success');
  emit('login_success', { enterprise, user });

  // 登录后检查弹窗（"登录已超时"等可能被踢下线的提示）
  await dismissExpiredModal(page);
  await sleep(2000);

  // 简化：每个命令都重新启动浏览器并复用 userDataDir（session cookie 由 Chrome profile 持久化）
  await browser.close();
  emit('done', { message: 'Login complete. Browser session saved in chrome-profile.' });
}

// ============================================================
// 2. 获取课表
// ============================================================

async function getCourses() {
  loadEnv();
  const browser = await launchBrowser(false);
  const page = await getOrCreatePage(browser);

  const loggedIn = await ensureLoggedIn(page);
  if (!loggedIn) throw new Error('Login failed; refusing to fetch courses');

  log('导航到课程中心...');
  const courses = await scrapeCourses(page);

  log(`✅ 抓取到 ${courses.length} 门课程`, 'success');
  emit('courses_fetched', { total: courses.length, courses });

  await browser.close();
}

// 共用：走完整流程抓课表（goto 主页 → 点 My Courses → 抓 .nc-mycourse-card）
// dump-eval 和 runAll 都用这个
async function scrapeCourses(page) {
  const COURSE_CENTER_URL = 'https://v4.21tb.com/els/html/index.parser.do?id=NEW_COURSE_CENTER&current_app_id=8a80810f5ab29060015ad1906d0b3811';
  const MY_COURSES_HASH = '#!/els/html/courseCenter/courseCenter.loadStudyTask.do';

  await page.goto(COURSE_CENTER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  await dismissExpiredModal(page);

  // 点"My Courses"链接
  log('点击 My Courses...');
  const clicked = await page.evaluate(() => {
    const links = document.querySelectorAll('a');
    for (const link of links) {
      if (link.textContent.includes('My Courses')) {
        link.click();
        return true;
      }
    }
    return false;
  });
  if (clicked) {
    await sleep(3000);
  } else {
    log('未找到 My Courses 链接，URL 兜底', 'warn');
    await page.goto(COURSE_CENTER_URL + MY_COURSES_HASH, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
  }
  await dismissExpiredModal(page);

  // 等待课程卡片
  try {
    await page.waitForSelector('.nc-mycourse-card', { timeout: 15000 });
  } catch (e) {
    log('未检测到 .nc-mycourse-card', 'warn');
  }
  await sleep(2000);

  // 抓课
  return await page.evaluate(() => {
    const result = [];
    document.querySelectorAll('.nc-mycourse-card').forEach((card, i) => {
      const link = card.querySelector('a.goStudy');
      const titleEl = card.querySelector('h3');
      const fullText = (card.textContent || '').replace(/\s+/g, ' ').trim();

      let progress = '';
      const rows = card.querySelectorAll('.mycourse-row');
      for (const row of rows) {
        if (row.textContent.includes('学习进度') || row.textContent.includes('Progress')) {
          progress = row.textContent.split(/[:：]/)[1]?.trim() || '';
          break;
        }
      }
      if (!progress) {
        const pm = fullText.match(/(?:Progress|学习进度)[:：]\s*(.*?)(?=Compulsory|Elective|Optional|Finish|必修|选修|任选|$)/i);
        if (pm) progress = pm[1].trim();
      }
      const isFinished = fullText.includes('Finish') || fullText.includes('已完成') || fullText.includes('完成');
      const id = link?.dataset?.id || '';
      const title = titleEl?.textContent?.trim() || '';
      if (title) result.push({ index: i + 1, id, title, progress, isFinished, fullText: fullText.substring(0, 200) });
    });
    return result;
  });
}

// ============================================================
// 3. 打开课程
// ============================================================

// ============================================================
// 页面状态检测
// ============================================================

async function getPageState(page) {
  return await page.evaluate(() => {
    const video = document.querySelector('video');
    const hasVideo = !!video;
    const videoPlaying = video && !video.paused && !video.ended && video.currentTime > 0;
    const videoEnded = video && video.ended;
    const hasRate = !!document.querySelector('.el-rate, .ant-rate');
    const hasTextarea = !!document.querySelector('textarea');
    const hasQuestionList = !!document.querySelector('.course-test-type-list-item');
    const hasChapterContainer = !!document.querySelector('.chapter-container, .learning-container, .section-list, .catalogue-wrap');
    const steps = Array.from(document.querySelectorAll('.steps-item, .el-steps__item')).map(s => s.textContent.trim().replace(/\s+/g, ' '));

    let pageType = 'unknown';
    if (hasVideo && videoPlaying) pageType = 'video_playing';
    else if (hasVideo && videoEnded) pageType = 'video_ended';
    else if (hasRate && (hasTextarea || hasQuestionList)) pageType = 'evaluation';
    else if (hasQuestionList) pageType = 'posttest';
    else if (hasRate) pageType = 'evaluation';
    else if (hasChapterContainer || hasVideo) pageType = 'video_idle';

    return {
      pageType,
      hasVideo,
      videoPlaying,
      videoEnded,
      hasRate,
      hasTextarea,
      hasQuestionList,
      hasChapterContainer,
      steps,
      url: location.href,
      title: document.title,
    };
  });
}

// ============================================================
// 确保已登录
// ============================================================

async function ensureLoggedIn(page) {
  loadEnv();
  const enterprise = process.env.TB_ENTERPRISE_ID || '';
  const user = process.env.TB_USER || '';
  const pass = process.env.TB_PASS || '';
  if (!enterprise || !user || !pass) throw new Error('Missing TB_ENTERPRISE_ID, TB_USER or TB_PASS');

  // 始终执行完整登录流程（不依赖 URL 判断）
  log('打开登录页...');
  await page.goto('https://v4.21tb.com/login/login.init.do', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  // 切换到密码登录模式
  log('切换到密码登录模式...');
  await page.evaluate(() => {
    if (typeof noErwei === 'function') noErwei();
    if (typeof changeWay === 'function') changeWay(1, document.getElementById('login-password'));
  });
  await sleep(1000);

  // 填写表单
  log(`填写企业ID: ${enterprise}`);
  await page.evaluate((e, u, p) => {
    const setVal = (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      if (window.$) $(el).val(value);
    };
    setVal('#corpCode', e);
    setVal('#loginName', u);
    setVal('#swInput', p);
  }, enterprise, user, pass);

  // 点击登录
  log('点击登录按钮...');
  await page.click('.login-btn');
  await sleep(5000);

  // 处理确认弹窗
  await page.evaluate(() => {
    document.querySelectorAll('button, .ant-btn, .el-button').forEach(b => {
      const t = b.textContent.trim();
      if (t === '确定' || t === '确 定' || t === '继续登录') b.click();
    });
  });
  await sleep(2000);

  const url = page.url();
  if (url.includes('login')) {
    // 21tb 有时完成鉴权后仍停留在登录 URL，但 session 已可用于课程中心。
    // 不在这里凭 URL 单点误判，下一步以能否抓到课程卡作为最终登录校验。
    log('登录后仍在登录 URL，将由课程中心访问结果继续校验 session', 'warn');
    emit('login_uncertain', { url });
    return true;
  }

  log('✅ 登录成功', 'success');
  return true;
}

// ============================================================
// 课程页、多章节与 AI 答题
// ============================================================

function parseJsonArray(text) {
  if (!text) return null;
  const raw = String(text).trim();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : (raw.match(/\[[\s\S]*\]/)?.[0] || '');
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeChoiceAnswer(answer, type, validKeys) {
  const keys = new Set((validKeys || []).map(k => String(k).toUpperCase()));
  const values = Array.isArray(answer) ? answer : [answer];
  const chunks = values.flatMap(value => String(value || '').toUpperCase().split(/[^A-Z]+/).filter(Boolean));
  let normalized = [...new Set(chunks.filter(value => keys.has(value)))];
  if (normalized.length === 0) {
    normalized = [...new Set(chunks.flatMap(value => value.length <= keys.size ? [...value] : []).filter(value => keys.has(value)))];
  }
  return type === 'multiple' ? normalized : (normalized[0] || '');
}

async function callAiForQuestions(questions) {
  const apiKey = process.env.ZHIPU_API_KEY || '';
  if (!apiKey) throw new Error('Missing ZHIPU_API_KEY in .env');
  const apiUrl = process.env.ZHIPU_API_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  const model = process.env.ZHIPU_MODEL || 'glm-4-flash';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: '你是严谨的课程测试答题助手。根据题干和选项作答。只输出 JSON 数组；每项字段为 index、answer、reason。单选/判断题 answer 是一个选项字母，多选题 answer 是字母数组，简答题 answer 是简洁中文答案。不得省略题目。',
          },
          { role: 'user', content: JSON.stringify({ questions }) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`AI HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content || '';
    const answers = parseJsonArray(content);
    if (!answers) throw new Error('AI response is not a JSON array');
    return { model, answers };
  } finally {
    clearTimeout(timer);
  }
}

async function openCoursePage(browser, courseListPage, course) {
  const targetCard = await courseListPage.evaluate((targetTitle) => {
    for (const card of document.querySelectorAll('.nc-mycourse-card')) {
      if ((card.textContent || '').includes(targetTitle)) {
        const link = card.querySelector('a.goStudy');
        if (link) return { found: true, selector: `a.goStudy[data-id="${link.dataset.id}"]` };
      }
    }
    return { found: false };
  }, course.title);

  let coursePage = courseListPage;
  if (targetCard.found) {
    const newTargetPromise = browser.waitForTarget(
      target => target.opener() === courseListPage.target(),
      { timeout: 12000 }
    ).catch(() => null);
    try {
      await courseListPage.click(targetCard.selector, { timeout: 5000 });
      log(`✅ 已点击课表卡 (${targetCard.selector})`, 'success');
      const newTarget = await newTargetPromise;
      if (newTarget) {
        const opened = await newTarget.page();
        if (opened) {
          coursePage = opened;
          log('✅ 已接管课程新标签页', 'success');
        }
      }
      await sleep(4000);
    } catch (e) {
      log(`点击课程卡失败: ${e.message}`, 'warn');
    }
  }

  const isCourseUrl = /\/courseSetting\/courseLearning\/play/i.test(coursePage.url());
  if (!isCourseUrl) {
    const courseUrl = `https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId=${course.id}`;
    log('未得到有效课程页，使用课程 URL 兜底', 'warn');
    coursePage = courseListPage;
    await coursePage.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  coursePage.setDefaultTimeout(30000);
  await dismissExpiredModal(coursePage);
  let ready = null;
  for (let loadAttempt = 1; loadAttempt <= 2; loadAttempt++) {
    for (let attempt = 1; attempt <= 15; attempt++) {
      ready = await coursePage.evaluate(() => ({
        url: location.href,
        hasCourseUi: !!document.querySelector('.chapter-box, .chapter-container, .steps-item-label, video'),
        title: document.title,
        bodyLength: document.body?.innerText?.length || 0,
        bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
        selectors: {
          chapterBox: document.querySelectorAll('.chapter-box').length,
          chapterContainer: document.querySelectorAll('.chapter-container').length,
          steps: document.querySelectorAll('.steps-item-label').length,
          video: document.querySelectorAll('video').length,
          iframes: document.querySelectorAll('iframe').length,
        },
      }));
      if (ready.hasCourseUi) break;
      await dismissExpiredModal(coursePage);
      await sleep(2000);
    }
    if (ready?.hasCourseUi) break;
    if (loadAttempt === 1 && ready?.bodyLength === 0) {
      emit('course_blank_reload', { url: ready.url });
      await coursePage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await dismissExpiredModal(coursePage);
    }
  }
  if (!/\/courseSetting\/courseLearning\/play/i.test(ready.url) || !ready.hasCourseUi) {
    emit('course_page_debug', ready);
    throw new Error(`Course page not ready: ${ready.url}`);
  }
  emit('course_page_ready', ready);
  return coursePage;
}

async function getChapterCatalog(page) {
  const candidates = [];
  for (const frame of page.frames()) {
    try {
      const summary = await frame.evaluate(() => ({
        chapterBox: document.querySelectorAll('.chapter-box').length,
        chapterListItem: document.querySelectorAll('.chapter-list-item').length,
        chapterItem: document.querySelectorAll('.chapter-item').length,
        hasContainer: !!document.querySelector('.chapter-container'),
        bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
      }));
      candidates.push({ frame, summary, url: frame.url() });
    } catch {}
  }
  const selected = candidates.sort((a, b) => {
    const score = item => item.summary.chapterBox * 100 + item.summary.chapterListItem * 10 + item.summary.chapterItem * 10 + (item.summary.hasContainer ? 1 : 0);
    return score(b) - score(a);
  })[0];
  if (!selected) return { selector: '', frameUrl: '', items: [] };
  return await selected.frame.evaluate((frameUrl) => {
    const container = document.querySelector('.chapter-container, .learning-container, .section-list, .catalogue-wrap');
    let node = container;
    let component = null;
    while (node && !component) {
      component = node.__vue__ || node.__vueParentComponent?.proxy || null;
      node = node.parentElement;
    }
    const courseData = component?.$data?.courseData || component?.courseData;
    const curIndex = component?.$data?.curIndex || component?.curIndex || [];
    if (Array.isArray(courseData)) {
      const resources = [];
      courseData.forEach((chapter, chapterIdx) => {
        const list = Array.isArray(chapter?.resourceDTOS) ? chapter.resourceDTOS : [];
        list.forEach((resource, sectionIdx) => {
          resources.push({
            index: resources.length,
            chapterIdx,
            sectionIdx,
            resourceId: resource.resourceId || '',
            text: String(resource.resourceName || resource.name || `章节 ${resources.length + 1}`).slice(0, 120),
            type: resource.type || resource.resourceType || '',
            active: Number(curIndex?.[0]) === chapterIdx && Number(curIndex?.[1]) === sectionIdx,
            finished: resource.finish === true || resource.finish === 1,
          });
        });
      });
      if (resources.length > 0) return { mode: 'vue', selector: '', frameUrl, items: resources };
    }

    const selectors = ['.chapter-box', '.chapter-list-item', '.chapter-item'];
    let items = [];
    let selector = '';
    for (const candidate of selectors) {
      const found = Array.from(document.querySelectorAll(candidate)).filter(el => el.offsetParent !== null);
      if (found.length > 0) {
        items = found;
        selector = candidate;
        break;
      }
    }
    return {
      mode: 'dom',
      selector,
      frameUrl,
      items: items.map((el, index) => {
        const cls = String(el.className || '');
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return {
          index,
          text: text.slice(0, 120),
          active: /active|current|is-active/.test(cls),
          finished: /finish|complete|completed|is-finish/.test(cls) || /已完成/.test(text),
        };
      }),
    };
  }, selected.url);
}

async function selectChapter(page, catalog, index) {
  const frame = page.frames().find(candidate => candidate.url() === catalog.frameUrl) || page.mainFrame();
  if (catalog.mode === 'vue') {
    const target = catalog.items[index];
    if (!target) return false;
    const switched = await frame.evaluate(({ chapterIdx, sectionIdx }) => {
      const container = document.querySelector('.chapter-container, .learning-container, .section-list, .catalogue-wrap');
      let node = container;
      let component = null;
      while (node && !component) {
        component = node.__vue__ || node.__vueParentComponent?.proxy || null;
        node = node.parentElement;
      }
      const courseData = component?.$data?.courseData || component?.courseData;
      const resource = courseData?.[chapterIdx]?.resourceDTOS?.[sectionIdx];
      if (!component || !resource) return false;
      if (typeof component.checkoutSection === 'function') {
        component.checkoutSection(resource, chapterIdx, sectionIdx);
        return 'checkoutSection';
      }
      if (typeof component.jumpPeriod === 'function') {
        component.jumpPeriod(resource, chapterIdx, sectionIdx);
        return 'jumpPeriod';
      }
      return false;
    }, target);
    if (switched) {
      emit('chapter_switched', { index, via: switched, chapter: target });
      for (let attempt = 1; attempt <= 10; attempt++) {
        await sleep(500);
        const fresh = await getChapterCatalog(page);
        if (fresh.items[index]?.active) {
          emit('chapter_switch_confirmed', { index, attempt, chapter: fresh.items[index] });
          await sleep(1500);
          return true;
        }
      }
      emit('chapter_switch_failed', { index, chapter: target });
      return false;
    }
    return false;
  }
  if (!catalog.selector) return false;
  const clicked = await frame.evaluate(({ selector, index }) => {
    const items = Array.from(document.querySelectorAll(selector)).filter(el => el.offsetParent !== null);
    const item = items[index];
    if (!item) return false;
    item.scrollIntoView({ block: 'center' });
    item.click();
    return true;
  }, { selector: catalog.selector, index });
  if (clicked) await sleep(3000);
  return clicked;
}

async function getLearningState(page) {
  const states = [];
  for (const frame of page.frames()) {
    if (/7moor|moor_chat|webchat/i.test(frame.url())) continue;
    try {
      const state = await frame.evaluate(() => {
        const videos = Array.from(document.querySelectorAll('video')).filter(v => v.offsetParent !== null || v.clientWidth > 0);
        const video = videos[0] || null;
        const text = document.body?.innerText || '';
        const match = text.match(/还需观看\s*(\d+):(\d+)/);
        return {
          hasVideo: !!video,
          video: video ? {
            ended: video.ended,
            paused: video.paused,
            currentTime: Number(video.currentTime || 0),
            duration: Number(video.duration || 0),
          } : null,
          remaining: match ? Number(match[1]) * 60 + Number(match[2]) : null,
          explicitComplete: /已完成学习|本节已完成|当前章节已完成/.test(text),
          loading: /加载中|正在加载/.test(text),
          bodyLength: text.length,
        };
      });
      states.push({ ...state, frameUrl: frame.url() });
    } catch {}
  }
  return states.sort((a, b) => {
    const score = state => (state.hasVideo ? 100 : 0) + (state.remaining !== null ? 50 : 0) + (state.explicitComplete ? 20 : 0) + Math.min(10, state.bodyLength / 1000);
    return score(b) - score(a);
  })[0] || { hasVideo: false, video: null, remaining: null, explicitComplete: false, loading: false, frameUrl: '' };
}

async function learnCurrentChapter(page, chapter, rate) {
  const startedAt = Date.now();
  let sawCountdown = false;
  let sawVideo = false;
  let stableNoGate = 0;
  let lastRemaining = null;
  while (Date.now() - startedAt < 10 * 60 * 1000) {
    const catalog = await getChapterCatalog(page);
    const freshChapter = catalog.items.find(item =>
      (chapter.resourceId && item.resourceId === chapter.resourceId) ||
      (!chapter.resourceId && item.index === chapter.index)
    );
    if (freshChapter?.finished) {
      return { ok: true, mode: sawVideo ? 'video' : 'document', reason: 'platform_finish_flag' };
    }
    const state = await getLearningState(page);

    if (state.hasVideo) {
      sawVideo = true;
      const mediaFrame = page.frames().find(frame => frame.url() === state.frameUrl) || page.mainFrame();
      await mediaFrame.evaluate(r => {
        const video = Array.from(document.querySelectorAll('video')).find(v => v.offsetParent !== null || v.clientWidth > 0);
        if (!video) return;
        video.muted = true;
        video.playbackRate = r;
        if (video.paused && !video.ended) video.play().catch(() => {});
      }, rate);
      const v = state.video;
      if (v.ended || (v.duration > 0 && v.currentTime >= v.duration - 0.5)) {
        await sleep(4000);
        return { ok: true, mode: 'video', reason: 'video_ended' };
      }
      const pct = v.duration > 0 ? Math.round(v.currentTime / v.duration * 100) : 0;
      log(`章节 ${chapter.index + 1} 视频进度 ${pct}% (${Math.round(v.currentTime)}/${Math.round(v.duration)}s)`);
      await sleep(3000);
      continue;
    }

    if (state.remaining !== null) {
      sawCountdown = true;
      lastRemaining = state.remaining;
      stableNoGate = 0;
      log(`章节 ${chapter.index + 1} 文档剩余 ${state.remaining}s`);
      if (state.remaining <= 0) return { ok: true, mode: 'document', reason: 'countdown_zero' };
      await sleep(1500);
      continue;
    }

    if (sawCountdown) {
      // iframe 加载时倒计时会短暂消失；只有已接近 0 才把消失视为完成。
      if (lastRemaining !== null && lastRemaining <= 60) {
        await sleep(3000);
        const confirm = await getLearningState(page);
        if (confirm.remaining === null) return { ok: true, mode: 'document', reason: 'countdown_completed' };
      }
      await sleep(1000);
      continue;
    }

    if (!state.loading) stableNoGate++;
    if (stableNoGate >= 15) {
      return { ok: false, mode: sawVideo ? 'video' : 'unknown', reason: 'no_learning_gate' };
    }
    await sleep(2000);
  }
  return { ok: false, mode: sawVideo ? 'video' : 'document', reason: 'chapter_timeout' };
}

async function learnAllChapters(page, rate) {
  let catalog = await getChapterCatalog(page);
  if (catalog.items.length === 0) {
    const opened = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, a, div, span, li')).filter(el => el.offsetParent !== null);
      const target = elements.find(el => (el.textContent || '').trim() === '目录' && el.children.length === 0);
      if (!target) return false;
      target.click();
      return true;
    });
    if (opened) {
      emit('chapter_catalog_opened', {});
      for (let attempt = 1; attempt <= 10; attempt++) {
        await sleep(1000);
        catalog = await getChapterCatalog(page);
        if (catalog.items.length > 0) break;
      }
    }
  }
  if (catalog.items.length === 0) {
    log('未发现章节目录，按单章节课程处理', 'warn');
    const result = await learnCurrentChapter(page, { index: 0, text: '单章节' }, rate);
    emit('chapter_result', { index: 0, total: 1, ...result });
    return result.ok;
  }

  emit('chapters_detected', { total: catalog.items.length, chapters: catalog.items });
  for (let index = 0; index < catalog.items.length; index++) {
    catalog = await getChapterCatalog(page);
    const chapter = catalog.items[index];
    if (!chapter) throw new Error(`Chapter ${index + 1} disappeared`);
    emit('chapter_start', { index, total: catalog.items.length, chapter });
    if (!chapter.active) {
      const selected = await selectChapter(page, catalog, index);
      if (!selected) throw new Error(`Failed to select chapter ${index + 1}`);
    }
    if (chapter.finished) {
      emit('chapter_skipped', { index, reason: 'already_finished', chapter });
      continue;
    }
    const result = await learnCurrentChapter(page, chapter, rate);
    emit('chapter_result', { index, total: catalog.items.length, chapter, ...result });
    if (!result.ok) throw new Error(`Chapter ${index + 1} failed: ${result.reason}`);
    await sleep(4000);
  }
  return true;
}

async function inspectFrames(page) {
  const frames = [];
  for (const frame of page.frames()) {
    try {
      frames.push(await frame.evaluate(frameUrl => ({
        url: frameUrl,
        title: document.title,
        bodyLength: document.body?.innerText?.length || 0,
        bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 240),
        chapterBox: document.querySelectorAll('.chapter-box').length,
        chapterContainer: document.querySelectorAll('.chapter-container').length,
        video: document.querySelectorAll('video').length,
        textarea: document.querySelectorAll('textarea').length,
      }), frame.url()));
    } catch (error) {
      frames.push({ url: frame.url(), error: error.message });
    }
  }
  return frames;
}

function isTransientPageError(error) {
  return /detached Frame|Execution context was destroyed|Cannot find context with specified id|Navigating frame was detached|Target closed/i.test(error?.message || '');
}

async function clickCourseStep(page, names) {
  let lastTransientError = '';
  for (let attempt = 1; attempt <= 10; attempt++) {
    for (const frame of page.frames()) {
      if (/7moor|moor_chat|webchat/i.test(frame.url())) continue;
      try {
        const result = await frame.evaluate(targets => {
          const visible = element => !!element && element.offsetParent !== null;
          const labels = Array.from(document.querySelectorAll('.steps-item-label.is-canenter, .steps-item-label, .el-step'));
          const target = labels.find(label => visible(label) && targets.some(name => (label.textContent || '').includes(name)));
          if (!target) return { clicked: false, text: '' };
          target.click();
          return { clicked: true, text: (target.textContent || '').trim() };
        }, names);
        if (result.clicked) {
          await sleep(3000);
          return { ...result, attempt };
        }
      } catch (error) {
        if (!isTransientPageError(error)) throw error;
        lastTransientError = error.message;
      }
    }
    await sleep(1000);
  }
  return { clicked: false, text: '', transientError: lastTransientError };
}

async function fillAndSubmitEvaluation(page) {
  let evalFrame = null;
  for (let attempt = 1; attempt <= 15 && !evalFrame; attempt++) {
    for (const frame of page.frames()) {
      if (/7moor|moor_chat|webchat/i.test(frame.url())) continue;
      try {
        const score = await frame.evaluate(() => {
          const visible = el => !!el && el.offsetParent !== null;
          const rate = Array.from(document.querySelectorAll('.el-rate, .ant-rate')).some(visible);
          const textarea = Array.from(document.querySelectorAll('textarea')).some(visible);
          const questions = Array.from(document.querySelectorAll('.course-test-type-list-item, [class*="test-type-list-item"], [class*="question-item"]')).some(visible);
          const submit = Array.from(document.querySelectorAll('button, .el-button, .ant-btn')).some(button => visible(button) && /提交|确定/.test((button.textContent || '').replace(/\s+/g, '')));
          return (rate ? 4 : 0) + (textarea ? 2 : 0) + (questions ? 2 : 0) + (submit ? 1 : 0);
        });
        if (score >= 4) { evalFrame = frame; break; }
      } catch {}
    }
    if (!evalFrame) await sleep(1000);
  }
  if (!evalFrame) {
    return { found: false, submitted: false, reason: 'evaluation_form_not_found', frames: await inspectFrames(page) };
  }
  const filled = await evalFrame.evaluate(() => {
    const rate = document.querySelector('.el-rate, .ant-rate');
    if (rate) {
      const stars = rate.querySelectorAll('.el-rate__item, .ant-rate-star, [class*="rate__item"], [class*="rate-star"]');
      const star = stars[stars.length - 1];
      if (star) (star.querySelector('.el-rate__icon, [role="radio"], .ant-rate-star-first') || star).click();
    }
    let choices = 0;
    const questions = document.querySelectorAll('.course-test-type-list-item, [class*="test-type-list-item"], [class*="question-item"]');
    questions.forEach(question => {
      if (question.querySelector('textarea')) return;
      const options = question.querySelectorAll('.el-radio, .ant-radio-wrapper, [class*="radio-wrapper"]');
      const target = options[options.length - 1];
      if (target) { (target.querySelector('input') || target).click(); choices++; }
    });
    let essays = 0;
    document.querySelectorAll('textarea').forEach(textarea => {
      if (textarea.offsetParent === null) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '很不错，高效，有趣');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      essays++;
    });
    return { choices, essays };
  });
  await sleep(800);
  const submit = await evalFrame.evaluate(() => {
    const excluded = /关闭|取消|返回|退出|登录|重置/;
    const buttons = Array.from(document.querySelectorAll('button, .el-button, .ant-btn')).filter(button => button.offsetParent !== null && !button.disabled);
    const target = buttons.find(button => {
      const text = (button.textContent || '').replace(/\s+/g, '');
      return /提交评估|提交|确定/.test(text) && !excluded.test(text);
    });
    if (!target) return { clicked: false };
    target.click();
    return { clicked: true, text: (target.textContent || '').trim() };
  });
  if (!submit.clicked) return { found: true, submitted: false, filled, reason: 'submit_not_found' };
  await sleep(2500);
  try {
    await evalFrame.evaluate(() => {
      const buttons = document.querySelectorAll('button, .el-button, .ant-btn');
      buttons.forEach(button => {
        const text = (button.textContent || '').replace(/\s+/g, '');
        if (/^(确定|知道了|OK|关闭|确认)$/.test(text) && button.offsetParent !== null) button.click();
      });
    });
  } catch (error) {
    // 提交后平台会替换课程 iframe；旧 frame 失效本身说明页面已发生预期跳转。
    if (!isTransientPageError(error)) throw error;
    emit('evaluation_frame_replaced', { message: error.message });
  }
  await sleep(1000);
  return { found: true, submitted: true, filled, ...submit };
}

async function extractPostTestQuestions(page) {
  for (let attempt = 1; attempt <= 15; attempt++) {
    for (const frame of page.frames()) {
      if (/7moor|moor_chat|webchat/i.test(frame.url())) continue;
      try {
        const questions = await frame.evaluate(() => {
          const visible = element => !!element && element.offsetParent !== null;
          if (Array.from(document.querySelectorAll('.el-rate, .ant-rate')).some(visible)) return [];
          const all = Array.from(document.querySelectorAll('.course-test-type-list-item, [class*="course-test-type-list-item"], [class*="question-item"]'));
          const items = all.filter(item => visible(item) && !all.some(other => other !== item && other.contains(item)));
          return items.map((item, index) => {
            const titleEl = item.querySelector('.course-test-type-list-item-title-content, [class*="question-title"], [class*="title"]');
            const stem = (titleEl?.textContent || item.textContent || '').replace(/\s+/g, ' ').trim();
            const optionEls = Array.from(item.querySelectorAll('.el-radio, .ant-radio-wrapper, .el-checkbox, .ant-checkbox-wrapper, [class*="radio-wrapper"], [class*="checkbox-wrapper"]'));
            const seen = new Set();
            const options = optionEls.map((el, optionIndex) => {
              const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
              const key = text.match(/^([A-Z])[\.、\s]/i)?.[1]?.toUpperCase() || String.fromCharCode(65 + optionIndex);
              return { key, text };
            }).filter(option => option.text && !seen.has(option.key) && seen.add(option.key));
            const hasTextarea = !!item.querySelector('textarea');
            const multiple = !!item.querySelector('.el-checkbox, .ant-checkbox-wrapper, [class*="checkbox-wrapper"]');
            return { index, stem, type: hasTextarea ? 'essay' : (multiple ? 'multiple' : 'single'), options };
          }).filter(question => question.stem && (question.type === 'essay' || question.options.length >= 2));
        });
        if (questions.length > 0) return { frame, questions };
      } catch {}
    }
    await sleep(1000);
  }
  return { frame: null, questions: [] };
}

async function answerPostTestWithAI(page) {
  let context = await extractPostTestQuestions(page);
  const questions = context.questions;
  if (questions.length === 0) return { found: false, submitted: false, reason: 'no_questions' };
  emit('questions_extracted', { count: questions.length, questions });
  log(`调用 AI 解答 ${questions.length} 道课后测试题...`);
  const ai = await callAiForQuestions(questions);
  const plan = [];
  for (const question of questions) {
    const item = ai.answers.find(answer => Number(answer.index) === question.index);
    if (!item) throw new Error(`AI omitted question ${question.index + 1}`);
    if (question.type === 'essay') {
      const answer = String(item.answer || '').trim();
      if (!answer) throw new Error(`AI returned empty essay answer for question ${question.index + 1}`);
      plan.push({ index: question.index, type: question.type, answer, reason: item.reason || '' });
      continue;
    }
    const answer = normalizeChoiceAnswer(item.answer, question.type, question.options.map(option => option.key));
    if ((question.type === 'multiple' && answer.length === 0) || (question.type !== 'multiple' && !answer)) {
      throw new Error(`AI returned invalid choice for question ${question.index + 1}`);
    }
    plan.push({ index: question.index, type: question.type, answer, reason: item.reason || '' });
  }

  // AI 调用期间页面可能重新渲染 iframe。提交前重新定位题目，并确保仍是同一份试卷。
  const refreshedContext = await extractPostTestQuestions(page);
  const fingerprint = items => items.map(item => `${item.type}:${item.stem}`).join('\n');
  if (fingerprint(refreshedContext.questions) !== fingerprint(questions)) {
    throw new Error('Post-test changed while AI was answering; refusing to apply stale answers');
  }
  context = refreshedContext;

  const applied = await context.frame.evaluate(planItems => {
    const all = Array.from(document.querySelectorAll('.course-test-type-list-item, [class*="course-test-type-list-item"], [class*="question-item"]'));
    const items = all.filter(item => item.offsetParent !== null && !all.some(other => other !== item && other.contains(item)));
    let count = 0;
    for (const plan of planItems) {
      const item = items[plan.index];
      if (!item) continue;
      if (plan.type === 'essay') {
        const textarea = item.querySelector('textarea');
        if (!textarea) continue;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(textarea, plan.answer);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        count++;
        continue;
      }
      const wanted = Array.isArray(plan.answer) ? plan.answer : [plan.answer];
      const options = Array.from(item.querySelectorAll('.el-radio, .ant-radio-wrapper, .el-checkbox, .ant-checkbox-wrapper, [class*="radio-wrapper"], [class*="checkbox-wrapper"]'));
      const unique = [];
      const seen = new Set();
      options.forEach((el, optionIndex) => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const key = text.match(/^([A-Z])[\.、\s]/i)?.[1]?.toUpperCase() || String.fromCharCode(65 + optionIndex);
        if (!seen.has(key)) { seen.add(key); unique.push({ el, key }); }
      });
      let selected = 0;
      for (const option of unique) {
        if (!wanted.includes(option.key)) continue;
        const input = option.el.querySelector('input');
        if (input && !input.checked) input.click();
        else if (!input) option.el.click();
        selected++;
      }
      if (selected === wanted.length) count++;
    }
    return count;
  }, plan);

  if (applied !== questions.length) throw new Error(`Only applied ${applied}/${questions.length} AI answers`);
  emit('ai_answers_applied', { model: ai.model, count: applied, answers: plan.map(({ index, type, answer }) => ({ index, type, answer })) });

  const submit = await context.frame.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, .el-button, .ant-btn')).filter(button => button.offsetParent !== null && !button.disabled);
    const target = buttons.find(button => /提交测试|确认提交|交卷|提交/.test((button.textContent || '').replace(/\s+/g, '')));
    if (!target) return { clicked: false };
    target.click();
    return { clicked: true, text: (target.textContent || '').trim() };
  });
  if (!submit.clicked) throw new Error('Post-test submit button not found');
  await sleep(3000);
  emit('posttest_submitted', { ...submit, model: ai.model });
  return { found: true, submitted: true, model: ai.model, count: questions.length };
}

async function testAiConnection() {
  loadEnv();
  const questions = [{
    index: 0,
    stem: '用于验证答题接口：1 + 1 等于多少？',
    type: 'single',
    options: [{ key: 'A', text: 'A. 1' }, { key: 'B', text: 'B. 2' }, { key: 'C', text: 'C. 3' }],
  }];
  const result = await callAiForQuestions(questions);
  const answer = result.answers.find(item => Number(item.index) === 0);
  const normalized = normalizeChoiceAnswer(answer?.answer, 'single', ['A', 'B', 'C']);
  if (normalized !== 'B') throw new Error(`AI connection test returned unexpected answer: ${normalized || 'empty'}`);
  emit('ai_test_success', { model: result.model, answer: normalized });
}

// ============================================================
// 一键全自动
// ============================================================

// 修复版主流程：接管新标签页、逐章节学习、AI 课后测试、严格完成验证。
async function runAll(keyword, rate = 16) {
  loadEnv();
  if (!keyword) throw new Error('Usage: run <keyword>');
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Invalid playback rate: ${rate}`);

  const browser = await launchBrowser(false);
  let courseListPage = null;
  try {
    courseListPage = await getOrCreatePage(browser);
    emit('phase', { phase: 'login' });
    const loggedIn = await ensureLoggedIn(courseListPage);
    if (!loggedIn) throw new Error('Login failed; refusing to continue');

    emit('phase', { phase: 'courses' });
    const courses = await scrapeCourses(courseListPage);
    if (courses.length === 0) throw new Error('Course list is empty');
    emit('courses_fetched', { total: courses.length, courses });

    const course = courses.find(item => item.title.toLowerCase().includes(keyword.toLowerCase()));
    if (!course) {
      emit('error', { message: 'No matching course', keyword, available: courses.map(item => item.title) });
      throw new Error(`No matching course: ${keyword}`);
    }
    emit('course_matched', { course });
    if (course.isFinished) {
      emit('already_complete', { course });
      return;
    }

    emit('phase', { phase: 'open_course' });
    let coursePage = await openCoursePage(browser, courseListPage, course);
    emit('course_frames_before_hook', { frames: await inspectFrames(coursePage) });

    // 课程页先完整初始化，再安装当前文档 Hook。切换/重选章节会创建新的倒计时并使用 Hook。
    // 禁止在这里 reload：实跑已证明 Hook 在 SPA 启动前生效会让课程页只剩空壳。
    await installDocSpeedupHook(coursePage);
    emit('course_frames_after_hook', { frames: await inspectFrames(coursePage) });

    emit('phase', { phase: 'learn_chapters' });
    const learned = await learnAllChapters(coursePage, rate);
    if (!learned) throw new Error('Not all chapters were learned');

    const requiresEvaluation = /课程评估|Course Evaluation/i.test(course.fullText || '');
    emit('phase', { phase: 'goto_eval' });
    const evalStep = await clickCourseStep(coursePage, ['课程评估', 'Course Evaluation']);
    emit('step_clicked', { step: 'evaluation', ...evalStep });
    if (evalStep.clicked) {
      emit('phase', { phase: 'fill_eval' });
      const evaluation = await fillAndSubmitEvaluation(coursePage);
      emit(evaluation.submitted ? 'eval_submitted' : 'eval_submit_failed', evaluation);
      if (requiresEvaluation && !evaluation.submitted) {
        throw new Error(`Required evaluation was not submitted: ${evaluation.reason}`);
      }
    } else if (requiresEvaluation) {
      throw new Error('Required evaluation step is unavailable');
    }

    // 评估提交后，测试可能自动出现，也可能需要显式点击步骤。
    emit('phase', { phase: 'posttest' });
    const posttestStep = await clickCourseStep(coursePage, ['课后测试', 'Post-test', 'Post Test']);
    emit('step_clicked', { step: 'posttest', ...posttestStep });
    const posttest = await answerPostTestWithAI(coursePage);
    if (posttest.found && !posttest.submitted) throw new Error(`Post-test was not submitted: ${posttest.reason}`);
    if (!posttest.found) emit('posttest_skipped', { reason: 'no_questions' });

    emit('phase', { phase: 'verify' });
    let verifiedCourse = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const refreshed = await scrapeCourses(courseListPage);
      verifiedCourse = refreshed.find(item => item.id === course.id || item.title.includes(course.title));
      emit('verify_result', { attempt, course: verifiedCourse || null });
      if (verifiedCourse?.isFinished) break;
      if (attempt < 3) await sleep(5000);
    }
    if (!verifiedCourse?.isFinished) {
      emit('incomplete', { course: verifiedCourse || course, message: 'Platform did not confirm completion' });
      throw new Error('Platform did not confirm course completion');
    }
    emit('all_done', { course: verifiedCourse });
    log(`🎉 平台已确认完成：${verifiedCourse.title}`, 'success');
  } finally {
    await browser.close().catch(() => {});
  }
}

// ============================================================
// 状态检查
// ============================================================

async function status() {
  const browser = await launchBrowser(true);
  const page = await getOrCreatePage(browser);
  await ensureLoggedIn(page);

  const state = await getPageState(page);
  emit('status', state);
  log(`页面类型: ${state.pageType}`);

  await browser.close();
}

// ============================================================
// 截图
// ============================================================

async function screenshot() {
  const browser = await launchBrowser(false);
  const page = await getOrCreatePage(browser);
  await ensureLoggedIn(page);

  const filepath = path.join(SCREENSHOT_DIR, `screenshot-${Date.now()}.png`);
  await page.screenshot({ path: filepath, fullPage: true });
  log(`截图保存: ${filepath}`, 'success');
  emit('screenshot', { path: filepath });

  await browser.close();
}

// ============================================================
// dump 评估页 DOM（走完整流程，session 不会冲突）
// ============================================================

async function dumpEval(keyword) {
  if (!keyword) {
    log('用法: node agent.js dump-eval <keyword>', 'error');
    return;
  }

  // 清理 SingletonLock（避免 Chrome 启动失败）
  const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'LOCK'];
  for (const f of lockFiles) {
    try { fs.unlinkSync(path.join(LOGS_DIR, 'chrome-profile', f)); } catch {}
  }

  const browser = await launchBrowser(false);
  const page = await getOrCreatePage(browser);
  page.setDefaultTimeout(30000);

  // 装 32x 文档加速 hook（必须在 goto 之前）
  await page.evaluateOnNewDocument(() => {
    if (window.__TBH_DOC_HOOK__) return;
    window.__TBH_DOC_HOOK__ = true;
    const o1 = window.setInterval;
    window.setInterval = function(fn, ms, ...args) {
      if (typeof ms === 'number' && ms >= 1000) ms = Math.max(31, Math.floor(ms / 32));
      return o1.call(this, fn, ms, ...args);
    };
    const o2 = window.setTimeout;
    window.setTimeout = function(fn, ms, ...args) {
      if (typeof ms === 'number' && ms >= 1000 && ms <= 60000) ms = Math.max(31, Math.floor(ms / 32));
      return o2.call(this, fn, ms, ...args);
    };
  });

  await ensureLoggedIn(page);
  log(`已登录，开始 dump 评估页: ${keyword}`, 'info');

  // 走完整流程：抓课表 → 点课表卡 → 等倒计时 → 点 step → dump
  const courses = await scrapeCourses(page);
  log(`✅ 抓到 ${courses.length} 门课`, 'success');

  const matched = courses.filter(c => c.title.toLowerCase().includes(keyword.toLowerCase()));
  if (matched.length === 0) {
    log(`未匹配到 "${keyword}"`, 'error');
    log(`课表: ${JSON.stringify(courses.map(c => c.title), null, 2)}`, 'info');
    await browser.close();
    return;
  }
  const course = matched[0];
  log(`匹配: ${course.title}`, 'success');

  // 点课表卡（按部就班）
  // 注意：a.goStudy 的 href 是 javascript:;，跳转靠 ng-click 绑定
  // Puppeteer 的 page.click() 会触发 ng-click（真实鼠标事件）
  const targetCard = await page.evaluate((targetTitle) => {
    const cards = document.querySelectorAll('.nc-mycourse-card');
    for (const card of cards) {
      if ((card.textContent || '').includes(targetTitle)) {
        const link = card.querySelector('a.goStudy');
        if (link) {
          const r = link.getBoundingClientRect();
          return { found: true, selector: `a.goStudy[data-id="${link.dataset.id}"]`, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
      }
    }
    return { found: false };
  }, course.title);
  if (!targetCard.found) {
    log('课表卡未找到', 'error');
    await browser.close();
    return;
  }
  log(`点击课表卡: ${targetCard.selector} at (${targetCard.x}, ${targetCard.y})`, 'info');
  const urlBefore = page.url();

  // 试 1: Puppeteer 真点击课表卡（最像真用户）
  let switched = false;
  try {
    await page.click(targetCard.selector, { timeout: 5000 });
    log('✅ page.click 成功', 'success');
    await sleep(5000);
    // 检查是否真的进入课程详情（看 bodyText 是否有"完成课程"等课程详情文字）
    const onDetail = await page.evaluate(() => {
      const t = document.body.innerText || '';
      return /完成课程|课程学习|课程评估|课后测试|开始学习/.test(t) &&
             !/我的课程\s*\d+|课程中心/.test(t);
    });
    if (onDetail) { switched = true; log('✅ 真点击进入课程详情', 'success'); }
  } catch (e) {
    log(`page.click 失败: ${e.message}`, 'warn');
  }
  // 试 2: page.goto 真实课程页 URL（最终兜底）
  // 单 Chrome 进程 + dismissExpiredModal 兜底，触发"登录超时"也会被处理
  if (!switched) {
    log('page.click 没进入详情，page.goto 真实 URL', 'error');
    const courseUrl = `https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId=${course.id}`;
    await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissExpiredModal(page);
    await sleep(5000);
    await dismissExpiredModal(page);
  }
  // 验证
  const shotClick = path.join(SCREENSHOT_DIR, `dump-eval-click-${Date.now()}.png`);
  await page.screenshot({ path: shotClick, fullPage: true });
  log(`点完截图: ${shotClick} (URL: ${page.url()})`, 'info');
  await sleep(5000);
  await dismissExpiredModal(page);
  const urlAfter = page.url();
  const shot5s = path.join(SCREENSHOT_DIR, `dump-eval-after-5s-${Date.now()}.png`);
  await page.screenshot({ path: shot5s, fullPage: true });
  log(`5s 后截图: ${shot5s} (URL: ${urlAfter})`, 'info');
  log(`URL 变化: ${urlBefore !== urlAfter ? '✅ 是' : '❌ 否'}`, urlBefore !== urlAfter ? 'success' : 'error');
  log(`进入课程详情: ${page.url().includes('courseSetting') ? '✅ 是' : '❌ 否'}`, page.url().includes('courseSetting') ? 'success' : 'error');

  // 等"还需观看"倒计时走完
  log('等待倒计时走完...');
  for (let i = 0; i < 60; i++) {
    const remaining = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const m = t.match(/还需观看\s*(\d+):(\d+)/);
      return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 0;
    });
    if (remaining === 0) { log('✅ 倒计时走完', 'success'); break; }
    if (i % 3 === 0) log(`  [${i * 2}s] 剩余 ${remaining}s`);
    await sleep(2000);
  }
  await sleep(3000);
  await dismissExpiredModal(page);

  // 截图：倒计时走完后
  const shot1 = path.join(SCREENSHOT_DIR, `dump-eval-1-after-countdown-${Date.now()}.png`);
  await page.screenshot({ path: shot1, fullPage: true });
  log(`截图 1: ${shot1}`, 'info');

  // dump chapter 信息
  const chapterInfo = await page.evaluate(() => {
    // 找章节列表
    const chapterEls = document.querySelectorAll('.chapter-item, .chapter-list-item, [class*="chapter-"], .course-section, .course-chapter');
    const chapters = Array.from(chapterEls).map(el => ({
      text: (el.textContent || '').trim().substring(0, 80),
      class: (el.className || '').substring(0, 60),
      active: el.classList.contains('active') || el.classList.contains('current'),
    }));
    // 找"下一节"按钮
    const nextBtns = Array.from(document.querySelectorAll('button, .el-button, .ant-btn, a'))
      .filter(b => b.offsetParent !== null)
      .filter(b => {
        const t = (b.textContent || '').trim();
        return t.includes('下一节') || t.includes('下一章') || t.includes('下一课') || t.includes('下一步') || t.includes('继续学习') || t === 'Next';
      })
      .map(b => ({ text: b.textContent.trim().substring(0, 30), class: (b.className || '').substring(0, 60) }));
    return { chapters, nextBtns, bodyText: (document.body.innerText || '').substring(0, 400) };
  });
  console.log('=== CHAPTER INFO ===');
  console.log(JSON.stringify(chapterInfo, null, 2));
  console.log('=== END CHAPTER ===');

  // 点"课程评估"step
  const stepResult = await page.evaluate(() => {
    const labels = document.querySelectorAll('.steps-item-label.is-canenter');
    for (const label of labels) {
      const t = (label.textContent || '').trim();
      if (t.includes('课程评估') || t.includes('Course Evaluation')) {
        label.click();
        return { clicked: true, text: t };
      }
    }
    return { clicked: false };
  });
  log(`step click: ${JSON.stringify(stepResult)}`);
  if (stepResult.clicked) await sleep(3000);
  await dismissExpiredModal(page);

  // dump DOM
  const dump = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, .el-button, .ant-btn'))
      .filter(b => b.offsetParent !== null)
      .map(b => ({
        text: b.textContent.trim().substring(0, 30),
        disabled: b.disabled,
        class: (b.className || '').substring(0, 60),
      }));
    const textareas = Array.from(document.querySelectorAll('textarea'))
      .filter(t => t.offsetParent !== null)
      .map(t => ({ disabled: t.disabled, placeholder: (t.placeholder || '').substring(0, 30) }));
    const stepLabels = Array.from(document.querySelectorAll('.steps-item-label'))
      .map(s => ({ text: (s.textContent || '').trim().substring(0, 30), class: s.className }));
    const rateItems = document.querySelectorAll('.el-rate__item, .ant-rate-star, [class*="rate__item"]').length;
    return {
      url: location.href,
      buttons: buttons.slice(0, 20),
      buttonsCount: buttons.length,
      textareas,
      stepLabels,
      rateItems,
      bodyText: (document.body.innerText || '').substring(0, 600),
    };
  });
  console.log('=== EVAL PAGE DUMP ===');
  console.log(JSON.stringify(dump, null, 2));
  console.log('=== END DUMP ===');

  const shot2 = path.join(SCREENSHOT_DIR, `dump-eval-2-final-${Date.now()}.png`);
  await page.screenshot({ path: shot2, fullPage: true });
  log(`截图 2: ${shot2}`, 'info');

  await browser.close();
}

// ============================================================
// 主入口
// ============================================================

async function main() {
  ensureDirs();
  loadEnv();

  const args = process.argv.slice(2);
  const command = args[0] || '';

  switch (command) {
    case 'login':
      await login();
      break;
    case 'courses':
      await getCourses();
      break;
    case 'status':
      await status();
      break;
    case 'screenshot':
      await screenshot();
      break;
    case 'run': {
      const rateArg = args.indexOf('--rate');
      const rate = rateArg >= 0 ? parseInt(args[rateArg + 1]) : 16;
      await runAll(args[1], rate);
      break;
    }
    case 'dump-eval':
      await dumpEval(args[1]);
      break;
    case 'test-ai':
      await testAiConnection();
      break;
    default:
      console.log(`Usage: node agent.js <command> [args]

Commands:
  login                       登录并获取课表
  courses                     仅获取课表
  status                      获取当前页面状态
  screenshot                  截图保存
  run <keyword> [--rate N]    一键全自动完成指定课程
  dump-eval <keyword>         走完整流程并 dump 评估页 DOM（用于排查评估提交失败）
  test-ai                    验证课后测试 AI 配置与返回格式

Environment (.env / .env.local):
  TB_ENTERPRISE_ID, TB_USER, TB_PASS
  ZHIPU_API_KEY, ZHIPU_API_URL, ZHIPU_MODEL (OpenAI-compatible AI settings)
`);
      break;
  }
}

if (require.main === module) {
  main().catch(err => {
    log(`Fatal error: ${err.message}`, 'error');
    emit('fatal_error', { message: err.message, stack: err.stack });
    process.exit(1);
  });
}

module.exports = {
  parseJsonArray,
  normalizeChoiceAnswer,
  isTransientPageError,
};
