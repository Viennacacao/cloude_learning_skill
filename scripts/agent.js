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
 *   node agent.js open <courseId>          # 打开课程
 *   node agent.js play [--rate 16]         # 播放视频并等待结束
 *   node agent.js steps                    # 列出 Steps 导航
 *   node agent.js goto-eval                # 跳转到课程评估步骤
 *   node agent.js fill-eval                # 填写并提交评估
 *   node agent.js check-posttest           # 检查是否有课后测试
 *   node agent.js answer-posttest          # 答题并提交
 *   node agent.js verify                   # 验证课程是否完成
 *   node agent.js status                   # 获取当前页面状态
 *   node agent.js run <keyword> [--rate 16] # 一键全自动（指定课程关键词）
 *   node agent.js screenshot              # 截图保存到 runtime-logs
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// ============================================================
// 工具函数
// ============================================================

const SKILL_ROOT = path.join(__dirname, '..');
const LOGS_DIR = path.join(SKILL_ROOT, 'runtime-logs');
const SESSION_FILE = path.join(LOGS_DIR, 'session.json');
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
  const envFile = path.join(SKILL_ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue;
    const idx = raw.indexOf('=');
    if (idx <= 0) continue;
    const key = raw.slice(0, idx).trim();
    const val = raw.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

function saveSession(data) {
  ensureDirs();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function loadSession() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')); }
  catch { return null; }
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

async function getOrCreatePage(browser) {
  const pages = await browser.pages();
  let page = pages[0] || await browser.newPage();
  // 注入 32x 加速 hook——必须在任何 goto 之前，对每个新文档都生效
  if (!page.__TBH_SPEEDUP_INSTALLED__) {
    page.__TBH_SPEEDUP_INSTALLED__ = true;
    await page.evaluateOnNewDocument(() => {
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
    });
  }
  return page;
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
  saveSession({ loggedIn: true, enterprise, user, loginAt: new Date().toISOString() });
  emit('login_success', { enterprise, user });

  // 不关闭浏览器，保持会话
  // 但因为是新进程，需要将 browser 存储为持久化
  // 实际上 Puppeteer browser 对象不能跨进程传递
  // 所以我们需要用 "connect" 模式或者每次重新启动

  // 方案：记录 wsEndpoint 用于后续连接
  const wsEndpoint = browser.wsEndpoint();
  saveSession({ loggedIn: true, enterprise, user, wsEndpoint, loginAt: new Date().toISOString() });
  emit('session_saved', { wsEndpoint });

  // 保持浏览器打开，不关闭
  // 进程退出后浏览器也会关闭，所以我们需要一个守护进程
  // 简化方案：每个命令都重新启动浏览器并复用 userDataDir
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

  // 先登录（复用 userDataDir，如果已登录会自动跳过）
  await ensureLoggedIn(page);

  log('导航到课程中心...');
  await page.goto('https://v4.21tb.com/els/html/courseCenter/courseCenter.loadStudyTask.do', {
    waitUntil: 'networkidle2', timeout: 30000
  });
  await sleep(5000);

  log('抓取课程列表...');
  const courses = await page.evaluate(() => {
    const result = [];
    const items = document.querySelectorAll('.nc-mycourse-card');
    items.forEach((item, i) => {
      const titleEl = item.querySelector('.course-title, .title, h3, h4, .name, [class*="title"]');
      const progressEl = item.querySelector('.progress, .progress-text, [class*="progress"], .status');
      const title = titleEl ? titleEl.textContent.trim() : '';
      const progress = progressEl ? progressEl.textContent.trim() : '';
      const id = item.getAttribute('data-course-id') || item.getAttribute('data-id') || '';
      const isFinished = progress.includes('已完成') || progress.includes('完成');
      if (title) result.push({ index: i + 1, id, title, progress, isFinished });
    });

    // 如果选择器没匹配到，尝试从表格行抓取
    if (result.length === 0) {
      const rows = document.querySelectorAll('.el-table__row, tr');
      rows.forEach((row, i) => {
        const cells = row.querySelectorAll('td, .cell');
        if (cells.length >= 2) {
          const title = cells[0]?.textContent?.trim() || '';
          const progress = cells[1]?.textContent?.trim() || '';
          if (title && title.length > 2 && title.length < 100) {
            result.push({ index: i + 1, id: '', title, progress, isFinished: progress.includes('完成') });
          }
        }
      });
    }

    return result;
  });

  // 保存课表
  const courseData = {
    updateTime: new Date().toISOString(),
    courses,
  };
  fs.writeFileSync(path.join(SKILL_ROOT, 'course-data.json'), JSON.stringify(courseData, null, 2), 'utf-8');

  log(`✅ 抓取到 ${courses.length} 门课程`, 'success');
  emit('courses_fetched', { total: courses.length, courses });

  await browser.close();
}

// ============================================================
// 3. 打开课程
// ============================================================

async function openCourse(courseId) {
  if (!courseId) {
    emit('error', { message: 'Usage: open <courseId>' });
    process.exit(1);
  }

  const browser = await launchBrowser(false);
  const page = await getOrCreatePage(browser);
  await ensureLoggedIn(page);

  const url = `https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId=${courseId}`;
  log(`打开课程: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(5000);

  const state = await getPageState(page);
  log(`页面状态: ${JSON.stringify(state)}`, 'info');
  emit('course_opened', { courseId, url, state });

  // 不关闭浏览器——但因为是新进程，我们截个图保存状态
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `course-open-${Date.now()}.png`) });

  await browser.close();
  emit('done', { message: 'Course opened. Check screenshot.' });
}

// ============================================================
// 4. 播放视频并等待结束
// ============================================================

async function playVideo(rate = 16) {
  const browser = await launchBrowser(false);
  const page = await getOrCreatePage(browser);
  await ensureLoggedIn(page);

  // 获取当前页面 URL——如果不在课程页，报错
  const url = page.url();
  if (!url.includes('courseSetting/courseLearning/play')) {
    emit('error', { message: 'Not on a course page. Open a course first.', url });
    await browser.close();
    process.exit(1);
  }

  log('检测视频元素...');
  const videoInfo = await page.evaluate(() => {
    const video = document.querySelector('video');
    if (!video) return { found: false };
    return {
      found: true,
      paused: video.paused,
      ended: video.ended,
      currentTime: video.currentTime,
      duration: video.duration,
      readyState: video.readyState,
    };
  });

  if (!videoInfo.found) {
    log('未找到视频元素——可能课程无视频或页面未加载完', 'warn');
    emit('no_video', { url });
    await browser.close();
    return;
  }

  log(`视频状态: 时长=${videoInfo.duration}s, 当前=${videoInfo.currentTime}s, 暂停=${videoInfo.paused}`);

  // 设置倍速并播放
  log(`设置 ${rate}x 倍速并播放...`);
  await page.evaluate((r) => {
    const video = document.querySelector('video');
    if (video) {
      video.playbackRate = r;
      video.muted = true;
      video.play().catch(() => {});
    }
  }, rate);

  emit('playback_started', { rate, duration: videoInfo.duration });

  // 轮询等待视频结束
  const pollInterval = 5000; // 5秒
  const maxWait = (videoInfo.duration || 3600) * 1000 / rate + 60000; // 预估时间 + 60s 余量
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    await sleep(pollInterval);

    const state = await page.evaluate(() => {
      const video = document.querySelector('video');
      if (!video) return { found: false };
      return {
        found: true,
        paused: video.paused,
        ended: video.ended,
        currentTime: video.currentTime,
        duration: video.duration,
      };
    });

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const progress = state.duration > 0 ? Math.round((state.currentTime / state.duration) * 100) : 0;
    log(`[${elapsed}s] 进度: ${progress}% (${Math.round(state.currentTime)}/${Math.round(state.duration)}s)`);

    emit('playback_progress', { progress, currentTime: state.currentTime, duration: state.duration });

    if (state.ended) {
      log('✅ 视频播放结束', 'success');
      emit('video_ended', { duration: state.duration });
      break;
    }

    if (!state.found) {
      log('视频元素消失——可能页面已跳转', 'warn');
      emit('video_lost', {});
      break;
    }

    // 如果视频暂停了（可能被平台暂停），重新播放
    if (state.paused && !state.ended && state.currentTime > 0) {
      log('视频被暂停，重新播放...', 'warn');
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) { v.playbackRate = 16; v.play().catch(() => {}); }
      });
    }
  }

  // 等待 3 秒让页面稳定
  log('等待 3 秒让页面稳定...');
  await sleep(3000);

  // 截图
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `after-play-${Date.now()}.png`) });

  // 检查页面状态——视频结束后应该能看到 Steps 导航
  const postState = await getPageState(page);
  log(`视频结束后页面状态: ${JSON.stringify(postState)}`, 'info');
  emit('post_play_state', postState);

  await browser.close();
  emit('done', { message: 'Video playback complete.' });
}

// ============================================================
// 5. Steps 导航
// ============================================================

async function listSteps() {
  const browser = await launchBrowser(false);
  const page = await getOrCreatePage(browser);
  await ensureLoggedIn(page);

  const steps = await page.evaluate(() => {
    const result = [];
    document.querySelectorAll('.steps-item, .el-steps__item, [class*="step-item"]').forEach((el, i) => {
      const text = el.textContent.trim().replace(/\s+/g, ' ');
      const isActive = el.classList.contains('is-active') || el.classList.contains('is-learning') || el.classList.contains('is-process');
      const canEnter = el.classList.contains('is-canenter') || !!el.querySelector('.is-canenter');
      result.push({ index: i, text, isActive, canEnter });
    });
    return result;
  });

  log(`找到 ${steps.length} 个步骤: ${steps.map(s => s.text).join(', ')}`);
  emit('steps', { steps });
  await browser.close();
}

async function gotoEval() {
  const browser = await launchBrowser(false);
  const page = await getOrCreatePage(browser);
  await ensureLoggedIn(page);

  log('查找"课程评估"步骤...');
  const clicked = await page.evaluate(() => {
    const steps = document.querySelectorAll('.steps-item, .el-steps__item, [class*="step-item"]');
    for (const step of steps) {
      const text = step.textContent.trim();
      if (text.includes('课程评估') || text.includes('Course Evaluation') || text.includes('评估')) {
        // 找到可点击的子元素
        const clickable = step.querySelector('.is-canenter, .steps-item-label, [class*="label"]') || step;
        clickable.click();
        return { clicked: true, text };
      }
    }
    return { clicked: false };
  });

  if (clicked.clicked) {
    log(`✅ 点击了"${clicked.text}"步骤`, 'success');
    await sleep(3000);
    const state = await getPageState(page);
    emit('step_clicked', { text: clicked.text, state });
  } else {
    log('未找到"课程评估"步骤', 'warn');
    emit('no_eval_step', {});
  }

  await browser.close();
  emit('done', {});
}

// ============================================================
// 6. 填写评估
// ============================================================

async function fillEval() {
  const browser = await launchBrowser(false);
  const page = await getOrCreatePage(browser);
  await ensureLoggedIn(page);

  // 确认在评估页
  const onEval = await page.evaluate(() => {
    const hasRate = !!document.querySelector('.el-rate, .ant-rate');
    const hasTextarea = !!document.querySelector('textarea');
    const hasVideo = !!document.querySelector('video');
    // 必须有星级评分 + 文本框，且没有正在播放的视频
    return hasRate && hasTextarea && !hasVideo;
  });

  if (!onEval) {
    log('当前不在评估页面', 'warn');
    emit('not_on_eval', {});
    await browser.close();
    return;
  }

  log('在评估页面，开始填写...', 'success');

  // 1. 星级评分——5星
  log('填写星级评分 (5星)...');
  await page.evaluate(() => {
    const rateEl = document.querySelector('.el-rate, .ant-rate');
    if (rateEl) {
      const stars = rateEl.querySelectorAll('.el-rate__item, .ant-rate-star, [class*="rate__item"], [class*="rate-star"]');
      if (stars.length >= 5) {
        const target = stars[4]; // 第5颗星
        const clickable = target.querySelector('.el-rate__icon, [role="radio"], .ant-rate-star-first') || target;
        clickable.click();
      }
    }
  });
  await sleep(500);

  // 2. 单选题——全部选 D
  log('填写单选题 (选D)...');
  const mcResult = await page.evaluate(() => {
    const items = document.querySelectorAll('.course-test-type-list-item, [class*="test-type-list-item"], [class*="question-item"]');
    let filled = 0;
    items.forEach(item => {
      if (item.querySelector('textarea') || item.textContent.includes('简答') || item.textContent.includes('论述')) return;

      const options = item.querySelectorAll('.el-radio, .ant-radio-wrapper, .ant-checkbox-wrapper, [class*="radio-wrapper"]');
      if (options.length === 0) return;

      // 优先按文字找 D
      let target = Array.from(options).find(o => {
        const t = o.textContent.trim().toUpperCase();
        return t === 'D' || t.startsWith('D.') || t.startsWith('D ') || t.startsWith('D、');
      });
      // 兜底：第4个选项
      if (!target && options.length >= 4) target = options[3];
      // 最终兜底：最后一个
      if (!target) target = options[options.length - 1];

      if (target) {
        const input = target.querySelector('.el-radio__input, .el-radio__original, input') || target;
        input.click();
        filled++;
      }
    });
    return { filled };
  });
  log(`单选题完成: ${mcResult.filled} 道`);
  await sleep(500);

  // 3. 问答题——固定答案
  log('填写问答题...');
  const essayResult = await page.evaluate(() => {
    const textareas = document.querySelectorAll('textarea');
    let filled = 0;
    textareas.forEach(ta => {
      if (ta.offsetParent === null) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '很不错，高效');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      filled++;
    });
    return { filled };
  });
  log(`问答题完成: ${essayResult.filled} 道`);
  await sleep(500);

  // 4. 提交——排除"关闭/取消"按钮
  log('查找提交按钮...');
  const submitResult = await page.evaluate(() => {
    const closeTexts = ['关 闭', '关闭', '取消', '取 消', '返回', '返 回', '报名', '注册', '我要', '退出', '登录', '重置'];
    const allBtns = Array.from(document.querySelectorAll('button, .el-button, .ant-btn'));

    // 优先：文字包含"提交"或"提交评估"，且不包含关闭类文字
    let target = allBtns.find(b => {
      const t = b.textContent.trim();
      return (t.includes('提交') || t.includes('提 交')) && !closeTexts.some(c => t.includes(c));
    });
    // 次选：文字为"确定"
    if (!target) {
      target = allBtns.find(b => {
        const t = b.textContent.trim();
        return (t === '确定' || t === '确 定') && !closeTexts.some(c => t.includes(c));
      });
    }
    // 不再有 primary 按钮兜底——太容易误点

    if (target) {
      target.click();
      return { clicked: true, text: target.textContent.trim() };
    }
    return { clicked: false };
  });

  if (submitResult.clicked) {
    log(`✅ 提交按钮点击成功: "${submitResult.text}"`, 'success');
    await sleep(2000);

    // 5. 处理提交后弹窗
    log('处理提交后弹窗...');
    await page.evaluate(() => {
      // 按 Escape
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    });
    await sleep(500);

    // 点击遮罩层
    await page.evaluate(() => {
      const masks = document.querySelectorAll('.el-overlay, .v-modal, .ant-modal-mask, .el-dialog__wrapper');
      masks.forEach(m => m.click());
      // 点击"确定/知道了"按钮
      const btns = document.querySelectorAll('button, .el-button, .ant-btn');
      btns.forEach(b => {
        const t = b.textContent.trim();
        if (/^(确定|确 定|知道了|OK|关 闭|关闭|确认)$/.test(t)) b.click();
      });
    });
    await sleep(1000);

    emit('eval_submitted', { submitText: submitResult.text, mc: mcResult.filled, essay: essayResult.filled });
  } else {
    log('❌ 未找到提交按钮', 'error');
    emit('eval_submit_failed', {});
  }

  await browser.close();
  emit('done', {});
}

// ============================================================
// 7. 课后测试
// ============================================================

async function checkPostTest() {
  const browser = await launchBrowser(false);
  const page = await getOrCreatePage(browser);
  await ensureLoggedIn(page);

  const state = await page.evaluate(() => {
    const hasQuestionList = !!document.querySelector('.course-test-type-list-item, [class*="course-test-type-list-item"]');
    const hasTestWrap = !!document.querySelector('.course-test-wrap, .course-test-content, [class*="course-test"]');
    const hasVideo = !!document.querySelector('video');
    const isPlaying = (() => {
      const v = document.querySelector('video');
      return v && !v.paused && !v.ended && v.currentTime > 0;
    })();
    return { hasQuestionList, hasTestWrap, hasVideo, isPlaying, isPostTest: (hasQuestionList && hasTestWrap) && !isPlaying };
  });

  log(`课后测试检测: ${JSON.stringify(state)}`);
  emit('posttest_check', state);

  await browser.close();
}

async function answerPostTest() {
  const browser = await launchBrowser(false);
  const page = await getOrCreatePage(browser);
  await ensureLoggedIn(page);

  // 提取题目
  log('提取课后测试题目...');
  const questions = await page.evaluate(() => {
    const result = [];
    const items = document.querySelectorAll('.course-test-type-list-item, [class*="course-test-type-list-item"]');
    items.forEach((item, i) => {
      const titleEl = item.querySelector('.course-test-type-list-item-title-content, [class*="title"]');
      const title = titleEl ? titleEl.textContent.trim() : `Question ${i + 1}`;
      const options = Array.from(item.querySelectorAll('.el-radio, .ant-radio-wrapper, .ant-checkbox-wrapper, [class*="radio-wrapper"], [class*="checkbox-wrapper"]')).map(o => o.textContent.trim());
      const hasTextarea = !!item.querySelector('textarea');
      result.push({ index: i, title, options, hasTextarea });
    });
    return result;
  });

  log(`提取到 ${questions.length} 道题`);
  emit('questions_extracted', { count: questions.length, questions });

  if (questions.length === 0) {
    log('未提取到题目', 'warn');
    await browser.close();
    return;
  }

  // 答题——全部选 D（兜底）
  log('答题中（兜底：全部选D）...');
  for (const q of questions) {
    if (q.hasTextarea) {
      // 问答题
      await page.evaluate((idx) => {
        const items = document.querySelectorAll('.course-test-type-list-item, [class*="course-test-type-list-item"]');
        const item = items[idx];
        if (item) {
          const ta = item.querySelector('textarea');
          if (ta) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, '很不错，高效');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      }, q.index);
    } else {
      // 选择题——选 D
      await page.evaluate((idx) => {
        const items = document.querySelectorAll('.course-test-type-list-item, [class*="course-test-type-list-item"]');
        const item = items[idx];
        if (!item) return;
        const options = item.querySelectorAll('.el-radio, .ant-radio-wrapper, [class*="radio-wrapper"]');
        if (options.length === 0) return;
        let target = Array.from(options).find(o => {
          const t = o.textContent.trim().toUpperCase();
          return t === 'D' || t.startsWith('D.') || t.startsWith('D ');
        });
        if (!target && options.length >= 4) target = options[3];
        if (!target) target = options[options.length - 1];
        if (target) {
          const input = target.querySelector('.el-radio__input, input') || target;
          input.click();
        }
      }, q.index);
    }
    await sleep(300);
  }

  log('答题完成，提交...');
  await sleep(1000);

  // 提交
  const submitted = await page.evaluate(() => {
    const closeTexts = ['关 闭', '关闭', '取消', '取 消', '返回', '报名', '注册', '我要', '退出', '登录', '重置'];
    const btns = Array.from(document.querySelectorAll('button, .el-button, .ant-btn'));
    let target = btns.find(b => {
      const t = b.textContent.trim();
      return (t.includes('提交') || t.includes('提 交') || t.includes('确认提交')) && !closeTexts.some(c => t.includes(c));
    });
    if (target) { target.click(); return { clicked: true, text: target.textContent.trim() }; }
    return { clicked: false };
  });

  if (submitted.clicked) {
    log(`✅ 课后测试提交成功: "${submitted.text}"`, 'success');
    emit('posttest_submitted', submitted);
    await sleep(2000);
    // 处理弹窗
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button, .el-button, .ant-btn');
      btns.forEach(b => {
        const t = b.textContent.trim();
        if (/^(确定|确 定|知道了|OK|关 闭|关闭)$/.test(t)) b.click();
      });
    });
  } else {
    log('❌ 未找到提交按钮', 'error');
    emit('posttest_submit_failed', {});
  }

  await browser.close();
  emit('done', {});
}

// ============================================================
// 8. 验证完成
// ============================================================

async function verify() {
  const browser = await launchBrowser(false);
  const page = await getOrCreatePage(browser);
  await ensureLoggedIn(page);

  // 导航到课程中心
  await page.goto('https://v4.21tb.com/els/html/courseCenter/courseCenter.loadStudyTask.do', {
    waitUntil: 'networkidle2', timeout: 30000
  });
  await sleep(5000);

  // 获取课程状态
  const courses = await page.evaluate(() => {
    const result = [];
    document.querySelectorAll('.nc-mycourse-card').forEach(item => {
      const title = item.querySelector('.course-title, .title, h3, h4')?.textContent?.trim() || '';
      const progress = item.querySelector('.progress, .progress-text, [class*="progress"]')?.textContent?.trim() || '';
      const isFinished = progress.includes('已完成') || progress.includes('完成');
      if (title) result.push({ title, progress, isFinished });
    });
    return result;
  });

  emit('verify_result', { courses });
  await browser.close();
}

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
    log('登录可能失败（仍在登录页）', 'warn');
    return false;
  }

  log('✅ 登录成功', 'success');
  return true;
}

// ============================================================
// 一键全自动
// ============================================================

async function runAll(keyword, rate = 16) {
  loadEnv();
  if (!keyword) {
    emit('error', { message: 'Usage: run <keyword>' });
    process.exit(1);
  }

  const browser = await launchBrowser(false);
  const page = await getOrCreatePage(browser);

  // --- 阶段 1: 登录 ---
  emit('phase', { phase: 'login' });
  await ensureLoggedIn(page);

  // --- 阶段 2: 获取课表 ---
  emit('phase', { phase: 'courses' });
  log('导航到课程中心...');

  // 先打开课程中心首页（index.parser.do），再点 My Courses
  const COURSE_CENTER_URL = 'https://v4.21tb.com/els/html/index.parser.do?id=NEW_COURSE_CENTER&current_app_id=8a80810f5ab29060015ad1906d0b3811';
  const MY_COURSES_HASH = '#!/els/html/courseCenter/courseCenter.loadStudyTask.do';

  await page.goto(COURSE_CENTER_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  // 尝试点击 "My Courses" 链接
  log('点击 "My Courses"...');
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
    log('已点击 My Courses 链接');
    await sleep(3000);
  } else {
    log('未找到 My Courses 链接，直接导航...', 'warn');
    await page.goto(COURSE_CENTER_URL + MY_COURSES_HASH, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);
  }

  log('等待课程卡片加载...');
  try {
    await page.waitForSelector('.nc-mycourse-card', { timeout: 15000 });
    log('课程卡片已加载', 'success');
  } catch (e) {
    log('未检测到 .nc-mycourse-card，尝试备用选择器...', 'warn');
    const altCount = await page.evaluate(() => ({
      card: document.querySelectorAll('.nc-mycourse-card').length,
      courseCard: document.querySelectorAll('.course-card').length,
      allCards: document.querySelectorAll('[class*="course"]').length,
      bodyLen: document.body.innerText.length,
      bodyText: document.body.innerText.substring(0, 500),
      url: location.href,
      title: document.title,
      courseClasses: Array.from(document.querySelectorAll('[class*="course"]')).map(el => ({
        tag: el.tagName,
        class: el.className.substring(0, 100),
        text: el.textContent.substring(0, 50).trim(),
      })),
      iframes: Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, id: f.id })),
    }));
    log(`页面状态: ${JSON.stringify(altCount)}`, 'warn');
    emit('page_debug', altCount);
  }
  await sleep(2000);

  const courses = await page.evaluate(() => {
    const result = [];
    document.querySelectorAll('.nc-mycourse-card').forEach((card, i) => {
      const link = card.querySelector('a.goStudy');
      const titleEl = card.querySelector('h3');
      const fullText = card.textContent.replace(/\s+/g, ' ').trim();
      
      // 解析进度
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

  // 匹配课程
  const matched = courses.filter(c => c.title.toLowerCase().includes(keyword.toLowerCase()));
  if (matched.length === 0) {
    log(`未匹配到包含 "${keyword}" 的课程`, 'error');
    emit('error', { message: 'No matching course', keyword, available: courses.map(c => c.title) });
    await browser.close();
    process.exit(1);
  }

  const course = matched[0];
  log(`✅ 匹配到课程: ${course.title}`, 'success');
  emit('course_matched', { course });

  // 如果课程已完成，直接退出
  if (course.isFinished) {
    log('课程已完成，无需重复学习', 'success');
    emit('already_complete', { course });
    await browser.close();
    return;
  }

  // --- 阶段 3: 打开课程 ---
  emit('phase', { phase: 'open_course' });
  const courseUrl = `https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId=${course.id}`;
  log(`打开课程: ${courseUrl}`);
  await page.goto(courseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(5000);

  // --- 阶段 3.5: 注入前端加速 hook（32x）---
  // 把 setInterval 中 >= 1000ms 的间隔除以 32，让"还需观看"倒计时秒走完
  // 注意：必须尽早注入（在 SPA 初始化之前）
  emit('phase', { phase: 'inject_speedup' });
  log('注入 32x 加速 hook...');
  await page.evaluate(() => {
    if (window.__TBH_SPEEDUP_INJECTED__) return;
    window.__TBH_SPEEDUP_INJECTED__ = true;
    const origSetInterval = window.setInterval;
    window.setInterval = function(fn, ms, ...args) {
      if (typeof ms === 'number' && ms >= 1000) {
        const newMs = Math.max(31, Math.floor(ms / 32));
        // console.log('[speedup] setInterval', ms, '→', newMs);
        ms = newMs;
      }
      return origSetInterval.call(this, fn, ms, ...args);
    };
    // 也 hook setTimeout（防止有倒计时用 setTimeout 链式调用）
    const origSetTimeout = window.setTimeout;
    window.setTimeout = function(fn, ms, ...args) {
      if (typeof ms === 'number' && ms >= 1000 && ms <= 60000) {
        // 只加速短中等的 setTimeout（< 60s），避免破坏长延迟
        ms = Math.max(31, Math.floor(ms / 32));
      }
      return origSetTimeout.call(this, fn, ms, ...args);
    };
    console.log('[speedup] 32x hook installed');
  });

  // --- 阶段 4: 检测页面状态 ---
  let state = await getPageState(page);
  log(`初始页面状态: ${state.pageType}`, 'info');
  emit('page_state', state);

  // --- 阶段 5: 播放视频 + 等待学习完成 ---
  emit('phase', { phase: 'play_or_wait' });

  // 5a. 如果有视频，先 16x 加速播放
  if (state.hasVideo) {
    log(`设置 ${rate}x 倍速并播放视频...`);
    await page.evaluate((r) => {
      const video = document.querySelector('video');
      if (video) {
        video.muted = true;
        video.playbackRate = r;
        video.play().catch(() => {});
      }
    }, rate);
    emit('playback_started', { rate });

    // 轮询等待视频 ended
    const start = Date.now();
    while (Date.now() - start < 600000) {
      await sleep(5000);
      const v = await page.evaluate(() => {
        const el = document.querySelector('video');
        if (!el) return { found: false };
        return { found: true, ended: el.ended, paused: el.paused, currentTime: el.currentTime, duration: el.duration };
      });
      if (!v.found || v.ended) {
        log('✅ 视频播放结束', 'success');
        emit('video_ended', {});
        break;
      }
      // 暂停 → 重新播放
      if (v.paused && !v.ended && v.currentTime > 0) {
        await page.evaluate(() => {
          const el = document.querySelector('video');
          if (el) { el.playbackRate = 16; el.play().catch(() => {}); }
        });
      }
    }
  }

  // 5b. 等待"还需观看 XX"倒计时走完（hook 32x 后 ~5-10 秒走完）
  log('等待学习倒计时走完...');
  const waitStart = Date.now();
  const maxWait = 60000; // 32x 加速后 10 分钟课 = 19 秒，60 秒足够
  while (Date.now() - waitStart < maxWait) {
    const remaining = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const m = t.match(/还需观看\s*(\d+):(\d+)/);
      if (m) {
        return parseInt(m[1]) * 60 + parseInt(m[2]);
      }
      return 0; // 没找到 = 已完成
    });
    if (remaining === 0) {
      log('✅ 倒计时已走完', 'success');
      break;
    }
    const elapsed = Math.round((Date.now() - waitStart) / 1000);
    log(`[${elapsed}s] 剩余 ${remaining}s`);
    await sleep(2000);
  }
  await sleep(3000);

  // 重新检测页面状态
  state = await getPageState(page);
  log(`学习完成后页面状态: ${state.pageType}`, 'info');
  emit('post_play_state', state);

  // --- 阶段 6: 导航到课程评估（强制执行，pageType 不可信）---
  emit('phase', { phase: 'goto_eval' });
  log('点击"课程评估"步骤...');

  const stepResult = await page.evaluate(() => {
    const labels = document.querySelectorAll('.steps-item-label.is-canenter');
    for (const label of labels) {
      const t = (label.textContent || '').trim();
      if (t.includes('课程评估') || t.includes('Course Evaluation')) {
        label.click();
        return { clicked: true, text: t };
      }
    }
    return { clicked: false, text: '' };
  });

  if (stepResult.clicked) {
    log(`✅ 点击了"${stepResult.text}"步骤`, 'success');
    await sleep(3000);
  } else {
    log('未找到可点击的"课程评估"步骤', 'warn');
    await sleep(2000);
  }
  state = await getPageState(page);
  log(`点击后页面状态: ${state.pageType}`, 'info');
  emit('step_clicked', stepResult);

  // --- 阶段 7: 填写评估 ---
  if (state.pageType === 'evaluation' || state.hasRate) {
    emit('phase', { phase: 'fill_eval' });
    log('在评估页面，开始填写...', 'success');

    // 星级评分
    await page.evaluate(() => {
      const rateEl = document.querySelector('.el-rate, .ant-rate');
      if (rateEl) {
        const stars = rateEl.querySelectorAll('.el-rate__item, .ant-rate-star, [class*="rate__item"], [class*="rate-star"]');
        if (stars.length >= 5) {
          const target = stars[4];
          const clickable = target.querySelector('.el-rate__icon, [role="radio"], .ant-rate-star-first') || target;
          clickable.click();
        }
      }
    });
    await sleep(500);

    // 单选题
    const mcResult = await page.evaluate(() => {
      const items = document.querySelectorAll('.course-test-type-list-item, [class*="test-type-list-item"], [class*="question-item"]');
      let filled = 0;
      items.forEach(item => {
        if (item.querySelector('textarea') || item.textContent.includes('简答') || item.textContent.includes('论述')) return;
        const options = item.querySelectorAll('.el-radio, .ant-radio-wrapper, [class*="radio-wrapper"]');
        if (options.length === 0) return;
        let target = Array.from(options).find(o => {
          const t = o.textContent.trim().toUpperCase();
          return t === 'D' || t.startsWith('D.') || t.startsWith('D ');
        });
        if (!target && options.length >= 4) target = options[3];
        if (!target) target = options[options.length - 1];
        if (target) { (target.querySelector('input') || target).click(); filled++; }
      });
      return filled;
    });
    log(`单选题: ${mcResult} 道`);
    await sleep(500);

    // 问答题
    const essayResult = await page.evaluate(() => {
      let filled = 0;
      document.querySelectorAll('textarea').forEach(ta => {
        if (ta.offsetParent === null) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '很不错，高效');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        filled++;
      });
      return filled;
    });
    log(`问答题: ${essayResult} 道`);
    await sleep(500);

    // 提交
    const submitResult = await page.evaluate(() => {
      const closeTexts = ['关 闭', '关闭', '取消', '取 消', '返回', '报名', '注册', '我要', '退出', '登录', '重置'];
      const btns = Array.from(document.querySelectorAll('button, .el-button, .ant-btn'));
      let target = btns.find(b => {
        const t = b.textContent.trim();
        return (t.includes('提交') || t.includes('提 交')) && !closeTexts.some(c => t.includes(c));
      });
      if (!target) {
        target = btns.find(b => {
          const t = b.textContent.trim();
          return (t === '确定' || t === '确 定') && !closeTexts.some(c => t.includes(c));
        });
      }
      // 不再有 primary 按钮兜底——太容易误点
      if (target) { target.click(); return { clicked: true, text: target.textContent.trim() }; }
      return { clicked: false };
    });

    if (submitResult.clicked) {
      log(`✅ 评估提交成功: "${submitResult.text}"`, 'success');
      emit('eval_submitted', submitResult);
      await sleep(2000);

      // 处理弹窗
      await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
        const btns = document.querySelectorAll('button, .el-button, .ant-btn');
        btns.forEach(b => {
          const t = b.textContent.trim();
          if (/^(确定|确 定|知道了|OK|关 闭|关闭|确认)$/.test(t)) b.click();
        });
      });
      await sleep(1000);
    } else {
      log('❌ 评估提交失败', 'error');
      emit('eval_submit_failed', {});
    }
  } else {
    log(`当前不在评估页面 (pageType=${state.pageType})，跳过评估`, 'warn');
  }

  // --- 阶段 8: 课后测试 ---
  state = await getPageState(page);
  if (state.pageType === 'posttest' || state.hasQuestionList) {
    emit('phase', { phase: 'posttest' });
    log('检测到课后测试...');

    // 提取题目
    const questions = await page.evaluate(() => {
      const result = [];
      document.querySelectorAll('.course-test-type-list-item, [class*="course-test-type-list-item"]').forEach((item, i) => {
        const titleEl = item.querySelector('.course-test-type-list-item-title-content, [class*="title"]');
        const title = titleEl ? titleEl.textContent.trim() : `Question ${i + 1}`;
        const options = Array.from(item.querySelectorAll('.el-radio, .ant-radio-wrapper, [class*="radio-wrapper"]')).map(o => o.textContent.trim());
        const hasTextarea = !!item.querySelector('textarea');
        result.push({ index: i, title: title.substring(0, 50), optionCount: options.length, hasTextarea });
      });
      return result;
    });

    log(`提取到 ${questions.length} 道题`);
    emit('questions_extracted', { count: questions.length, questions });

    // 答题
    for (const q of questions) {
      if (q.hasTextarea) {
        await page.evaluate((idx) => {
          const items = document.querySelectorAll('.course-test-type-list-item, [class*="course-test-type-list-item"]');
          const ta = items[idx]?.querySelector('textarea');
          if (ta) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, '很不错，高效');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }, q.index);
      } else {
        await page.evaluate((idx) => {
          const items = document.querySelectorAll('.course-test-type-list-item, [class*="course-test-type-list-item"]');
          const item = items[idx];
          if (!item) return;
          const options = item.querySelectorAll('.el-radio, .ant-radio-wrapper, [class*="radio-wrapper"]');
          if (options.length === 0) return;
          let target = Array.from(options).find(o => {
            const t = o.textContent.trim().toUpperCase();
            return t === 'D' || t.startsWith('D.');
          });
          if (!target && options.length >= 4) target = options[3];
          if (!target) target = options[options.length - 1];
          if (target) (target.querySelector('input') || target).click();
        }, q.index);
      }
      await sleep(300);
    }

    log('答题完成，提交...');
    await sleep(1000);

    const posttestSubmit = await page.evaluate(() => {
      const closeTexts = ['关 闭', '关闭', '取消', '取 消', '返回', '报名', '注册', '我要', '退出', '登录', '重置'];
      const btns = Array.from(document.querySelectorAll('button, .el-button, .ant-btn'));
      let target = btns.find(b => {
        const t = b.textContent.trim();
        return (t.includes('提交') || t.includes('提 交') || t.includes('确认提交')) && !closeTexts.some(c => t.includes(c));
      });
      if (target) { target.click(); return { clicked: true, text: target.textContent.trim() }; }
      return { clicked: false };
    });

    if (posttestSubmit.clicked) {
      log(`✅ 课后测试提交: "${posttestSubmit.text}"`, 'success');
      emit('posttest_submitted', posttestSubmit);
      await sleep(2000);
      // 处理弹窗
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button, .el-button, .ant-btn');
        btns.forEach(b => {
          const t = b.textContent.trim();
          if (/^(确定|确 定|知道了|OK|关 闭|关闭)$/.test(t)) b.click();
        });
      });
    }
  } else {
    log('无课后测试，跳过', 'info');
  }

  // --- 阶段 9: 验证 ---
  emit('phase', { phase: 'verify' });
  log('验证课程完成状态...');

  // 截图
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `final-${Date.now()}.png`) });

  // 获取最终状态
  const finalState = await getPageState(page);
  log(`最终页面状态: ${finalState.pageType}`, 'info');
  emit('final_state', finalState);

  // 导航到课程中心验证
  await page.goto('https://v4.21tb.com/els/html/courseCenter/courseCenter.loadStudyTask.do', {
    waitUntil: 'networkidle2', timeout: 30000
  });
  await sleep(5000);

  const finalCourses = await page.evaluate(() => {
    const result = [];
    document.querySelectorAll('.nc-mycourse-card').forEach(item => {
      const title = item.querySelector('.course-title, .title, h3, h4')?.textContent?.trim() || '';
      const progress = item.querySelector('.progress, .progress-text, [class*="progress"]')?.textContent?.trim() || '';
      if (title) result.push({ title, progress, isFinished: progress.includes('完成') });
    });
    return result;
  });

  const targetCourse = finalCourses.find(c => c.title.includes(keyword));
  if (targetCourse) {
    log(`课程状态: ${targetCourse.progress} | 完成=${targetCourse.isFinished}`, targetCourse.isFinished ? 'success' : 'warn');
    emit('verify_result', { course: targetCourse });
  }

  emit('all_done', { course: course.title });
  log('🎉 全部完成', 'success');

  await browser.close();
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
    case 'open':
      await openCourse(args[1]);
      break;
    case 'play':
      await playVideo(parseInt(args[2] || '16'));
      break;
    case 'steps':
      await listSteps();
      break;
    case 'goto-eval':
      await gotoEval();
      break;
    case 'fill-eval':
      await fillEval();
      break;
    case 'check-posttest':
      await checkPostTest();
      break;
    case 'answer-posttest':
      await answerPostTest();
      break;
    case 'verify':
      await verify();
      break;
    case 'status':
      await status();
      break;
    case 'screenshot':
      await screenshot();
      break;
    case 'run':
      const rateArg = args.indexOf('--rate');
      const rate = rateArg >= 0 ? parseInt(args[rateArg + 1]) : 16;
      await runAll(args[1], rate);
      break;
    default:
      console.log(`Usage: node agent.js <command> [args]

Commands:
  login                 登录
  courses               获取课表
  open <courseId>       打开课程
  play [--rate N]       播放视频并等待结束
  steps                 列出 Steps 导航
  goto-eval             跳转到课程评估
  fill-eval             填写并提交评估
  check-posttest        检查课后测试
  answer-posttest       答题并提交
  verify               验证完成状态
  status               获取当前页面状态
  screenshot           截图
  run <keyword> [--rate N]  一键全自动

Environment (.env):
  TB_ENTERPRISE_ID, TB_USER, TB_PASS
`);
      break;
  }
}

main().catch(err => {
  log(`Fatal error: ${err.message}`, 'error');
  emit('fatal_error', { message: err.message, stack: err.stack });
  process.exit(1);
});
