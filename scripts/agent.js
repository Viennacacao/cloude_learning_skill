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
    // reload/导航后旧 frame 会被销毁，evaluate 会抛 "detached Frame"——必须容错，否则整轮崩溃
    let has = false;
    try {
      has = await page.evaluate(() => {
        const t = document.body?.innerText || '';
        return /登录已超时|请重新登录|账号在其他设备|在其他设备登录/.test(t);
      });
    } catch {
      return false;
    }
    if (!has) return false;
    log(`⚠️  检测到登录超时弹窗（第 ${i + 1} 次），点"确定"...`, 'warn');
    try {
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
    } catch {
      return true;
    }
    await sleep(2000);
  }
  return true; // 出现过弹窗
}

async function getOrCreatePage(browser) {
  const pages = await browser.pages();
  return pages[0] || await browser.newPage();
}

// ============================================================
// 页面内常驻学习助手（混合架构的核心）
//
// 设计原则：加速这件事必须"一直在场"，交给页面内 setInterval；
// Node 只做编排（登录/选课/切章/评估）和只读状态，不再高频操作 DOM。
//
// 相比旧的"hook 全局 setInterval/setTimeout"做法：
//   - 不污染页面其它定时器（旧做法破坏过 aliplayer 进度上报，导致视频 0-12s 循环）
//   - 文档课直接改 Vue 组件 $data.recordTime（平台判定字段），精准无副作用
//   - play() 回调里立即重设 playbackRate，不会掉回 1x
//   - 1 秒巡检不会"错过"播放器瞬时重建，杜绝"采样不到视频"误判
// ============================================================

const STUDY_HELPER_INSTALLER = () => {
  if (window.__TBH__) return;
  window.__TBH__ = (function () {
    const S = {
      v: '3.0', running: false, mode: null,
      rate: 2, docSpeed: 30,
      video: null, doc: null,
      completed: false, completedReason: null,
      ticks: 0, rateResets: 0, resumes: 0, docTicks: 0,
      startedAt: 0, lastAdvanceAt: 0, maxCur: 0,
      timer: null,
    };

    // 放宽选取：播放器重建/祖先 fixed 时 offsetParent 会为 null
    // 音频课（type: mp3）只有 <audio> 没有 <video>，必须一起找，否则会退化成只推 recordTime
    function pickVideo() {
      const all = document.querySelectorAll('video, audio');
      for (let i = 0; i < all.length; i++) {
        const v = all[i];
        if (v.offsetParent !== null || v.clientWidth > 0) return v;
      }
      return all.length ? all[0] : null;
    }

    // 找 Vue 组件树里 name === 'course-play' 的实例（文档/音频课判定数据挂在它上面）
    // 性能关键：早期版本每秒都全量 querySelectorAll('*')，把页面直接拖死（日志卡在 recordTime 750 不动）。
    // 改为：缓存命中 + 全局扫描节流（3s 一次）+ 扫描上限。
    let cachedVm = null;
    let lastFullScanAt = 0;

    function vmMatches(vm) {
      let d = 0;
      while (vm && d < 20) {
        if (vm.$options && vm.$options.name === 'course-play') return true;
        vm = vm.$parent; d++;
      }
      return false;
    }

    function findCoursePlayVm() {
      if (cachedVm && cachedVm.$data && typeof cachedVm.$data.recordTime === 'number') return cachedVm;
      const now = Date.now();
      if (now - lastFullScanAt < 3000) return null;
      lastFullScanAt = now;

      // 快速路径：从 .tips-content 逐级向上
      const tips = document.querySelector('.tips-content');
      let el = tips;
      let guard = 0;
      while (el && guard++ < 30) {
        if (el.__vue__ && vmMatches(el.__vue__)) {
          cachedVm = el.__vue__;
          return cachedVm;
        }
        el = el.parentElement;
      }
      // 兜底：有限全局扫描
      const all = document.querySelectorAll('*');
      const limit = Math.min(all.length, 3000);
      for (let i = 0; i < limit; i++) {
        if (all[i].__vue__ && vmMatches(all[i].__vue__)) {
          cachedVm = all[i].__vue__;
          return cachedVm;
        }
      }
      return null;
    }

    function tick() {
      S.ticks++;
      const v = pickVideo();
      if (v) {
        S.mode = 'video';
        try { v.muted = true; } catch (e) {}
        // 维持倍速：播放器重建后 playbackRate 会掉回 1
        if (v.playbackRate !== S.rate) {
          try { v.playbackRate = S.rate; S.rateResets++; } catch (e) {}
        }
        // 暂停则续播——关键：在 play() 的回调里立即重设倍速
        if (v.paused && !v.ended) {
          S.resumes++;
          try {
            const p = v.play();
            if (p && p.then) {
              p.then(() => { try { v.playbackRate = S.rate; } catch (e) {} }).catch(() => {});
            }
          } catch (e) {}
        }
        const cur = v.currentTime || 0;
        const dur = v.duration || 0;
        if (cur > S.maxCur + 0.5) { S.maxCur = cur; S.lastAdvanceAt = Date.now(); }
        S.video = {
          cur: +cur.toFixed(1), dur: +dur.toFixed(1),
          rate: v.playbackRate, paused: v.paused, ended: v.ended, readyState: v.readyState,
        };
        if (v.ended || (dur > 0 && dur - cur < 5)) {
          S.completed = true;
          S.completedReason = 'video_end';
        }
        return;
      }

      S.video = null;
      // 文档课：直接推进平台用于判定的 recordTime
      const vm = findCoursePlayVm();
      if (vm && vm.$data && typeof vm.$data.recordTime === 'number') {
        S.mode = 'document';
        const min = typeof vm.$data.minStudyTime === 'number' ? vm.$data.minStudyTime : 900;
        if (vm.$data.recordTime < min) {
          vm.$data.recordTime = Math.min(min, vm.$data.recordTime + S.docSpeed);
          S.docTicks++;
          S.lastAdvanceAt = Date.now();
        } else {
          S.completed = true;
          S.completedReason = 'doc_recordTime_reached';
        }
        S.doc = { recordTime: vm.$data.recordTime, minStudyTime: min };
      }
    }

    return {
      start(rate, docSpeed) {
        if (rate) S.rate = rate;
        if (docSpeed) S.docSpeed = docSpeed;
        if (S.timer) clearInterval(S.timer);
        S.running = true; S.completed = false; S.completedReason = null;
        S.startedAt = Date.now(); S.lastAdvanceAt = Date.now(); S.maxCur = 0;
        cachedVm = null; lastFullScanAt = 0;   // 新章节要重新找组件
        tick();
        S.timer = setInterval(tick, 1000);
        return true;
      },
      stop() { if (S.timer) clearInterval(S.timer); S.timer = null; S.running = false; return true; },
      setRate(r) {
        S.rate = r;
        const v = pickVideo();
        if (v) { try { v.playbackRate = r; } catch (e) {} }
        return true;
      },
      // 停滞救援：先 pause/play 重启解码，仍无效则跳到结尾前 20s 用 2x 播完
      nudge() {
        const v = pickVideo();
        if (!v) return 'no_media';
        try {
          if (v.duration > 0 && v.currentTime < v.duration - 30) {
            v.pause();
            const target = Math.max(0, v.duration - 20);
            v.currentTime = target;
            v.playbackRate = Math.min(S.rate, 2);
            v.play().catch(() => {});
            S.lastAdvanceAt = Date.now();
            return 'seek_to_' + Math.round(target);
          }
          v.pause();
          setTimeout(() => { try { v.playbackRate = S.rate; v.play().catch(() => {}); } catch (e) {} }, 600);
          S.lastAdvanceAt = Date.now();
          return 'restart';
        } catch (e) {
          return 'error';
        }
      },
      reset() {
        S.completed = false; S.completedReason = null; S.maxCur = 0; S.lastAdvanceAt = Date.now();
        cachedVm = null; lastFullScanAt = 0;
        return true;
      },
      snapshot() {
        return {
          v: S.v, running: S.running, mode: S.mode, rate: S.rate,
          video: S.video, doc: S.doc,
          completed: S.completed, completedReason: S.completedReason,
          ticks: S.ticks, rateResets: S.rateResets, resumes: S.resumes, docTicks: S.docTicks,
          maxCur: +S.maxCur.toFixed(1),
          elapsedMs: S.startedAt ? Date.now() - S.startedAt : 0,
          sinceAdvanceMs: S.lastAdvanceAt ? Date.now() - S.lastAdvanceAt : -1,
        };
      },
    };
  })();
};

async function installStudyHelper(page) {
  await page.evaluateOnNewDocument(STUDY_HELPER_INSTALLER);
  await page.evaluate(STUDY_HELPER_INSTALLER).catch(() => {});
}

// 兼容旧调用点：统一走新的常驻助手（不再 hook 全局定时器）
async function installDocSpeedupHook(page) {
  await installStudyHelper(page);
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

// 在课表页点击目标课程卡，返回打开/跳转后的课程页（失败返回 { ok:false }）
// 这是进入课程的唯一正当途径——不允许绕过课表直接 goto 课程 URL。
async function clickCourseCard(browser, courseListPage, course) {
  const targetCard = await courseListPage.evaluate((targetTitle) => {
    for (const card of document.querySelectorAll('.nc-mycourse-card')) {
      if ((card.textContent || '').includes(targetTitle)) {
        const link = card.querySelector('a.goStudy');
        if (link) return { found: true, selector: `a.goStudy[data-id="${link.dataset.id}"]` };
      }
    }
    return { found: false };
  }, course.title);

  if (!targetCard.found) return { ok: false, reason: 'card_not_found' };

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
        await sleep(4000);
        if (/\/courseSetting\/courseLearning\/play/i.test(opened.url())) {
          log('✅ 已接管课程新标签页', 'success');
          return { ok: true, page: opened };
        }
      }
    }
    await sleep(4000);
    // 同一标签页内跳转的情况
    if (/\/courseSetting\/courseLearning\/play/i.test(courseListPage.url())) {
      log('✅ 课表页已跳转至课程页', 'success');
      return { ok: true, page: courseListPage };
    }
  } catch (e) {
    log(`点击课程卡失败: ${e.message}`, 'warn');
  }
  return { ok: false, reason: 'click_no_navigation' };
}

async function openCoursePage(browser, courseListPage, course) {
  const courseUrl = `https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId=${course.id}`;
  // 进入课程的严格顺序：
  //   ① 已登录的课表页点卡
  //   ② 点卡失败 → 重新登录（重建 session）→ 再点卡
  //   ③ 仍失败 → 才允许 goto 课程 URL（此时 session 已由 ② 建立，不会再弹"登录已超时"）
  let attempt = await clickCourseCard(browser, courseListPage, course);
  if (!attempt.ok) {
    log(`点课表卡未进入课程（${attempt.reason}），先重新登录再点一次`, 'warn');
    emit('course_card_retry_after_relogin', { reason: attempt.reason });
    await ensureLoggedIn(courseListPage);
    await scrapeCourses(courseListPage);
    attempt = await clickCourseCard(browser, courseListPage, course);
  }

  let coursePage = attempt.ok ? attempt.page : null;
  if (!coursePage) {
    log('两次点卡均未进入课程，使用课程 URL 兜底（session 已就绪）', 'warn');
    coursePage = courseListPage;
    await coursePage.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  // 课程页是新标签时默认不在前台，Chrome 会把它的 setInterval 节流到分钟级，
  // 页面内助手就跑不动（文档/音频课 recordTime 会卡住）。必须激活。
  await coursePage.bringToFront().catch(() => {});

  // 若被"登录已超时"弹窗拦下，说明 session 在中途失效：重登 → 回课表 → 重新点卡（最多 2 轮）
  for (let guard = 1; guard <= 2; guard++) {
    const kicked = await dismissExpiredModal(coursePage);
    if (!kicked) break;
    log(`课程页被登录超时弹窗拦截（第 ${guard} 轮），重新登录后重进课程`, 'warn');
    emit('course_page_relogin', { guard });
    await ensureLoggedIn(courseListPage);
    await scrapeCourses(courseListPage);
    attempt = await clickCourseCard(browser, courseListPage, course);
    if (attempt.ok) { coursePage = attempt.page; continue; }
    if (coursePage !== courseListPage) { try { await coursePage.close(); } catch {} }
    coursePage = courseListPage;
    await coursePage.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  coursePage.setDefaultTimeout(30000);
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
      // checkoutSection 在文档章节会对 null 播放器读 .duration 抛异常——
      // 但切换其实已经生效，必须吞掉异常，否则整轮崩掉
      try {
        if (typeof component.checkoutSection === 'function') {
          component.checkoutSection(resource, chapterIdx, sectionIdx);
          return 'checkoutSection';
        }
        if (typeof component.jumpPeriod === 'function') {
          component.jumpPeriod(resource, chapterIdx, sectionIdx);
          return 'jumpPeriod';
        }
      } catch (e) {
        return 'checkoutSection(threw:' + (e && e.message ? e.message.slice(0, 60) : 'unknown') + ')';
      }
      return false;
    }, target).catch(() => false);
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
      // vue 路径没确认成功（音频/文档章节常见 checkoutSection 抛异常）——回退到 DOM 点击
      emit('chapter_switch_failed', { index, chapter: target, note: 'vue 路径未确认，回退 DOM 点击' });
    }
  }
  // vue 模式下 catalog.selector 是空串，回退 DOM 点击前先探测一个可用的章节卡片选择器
  if (!catalog.selector) {
    for (const sel of ['.chapter-box', '.chapter-item', '.chapter', '.section-item', '.catalogue-item']) {
      const n = await page.evaluate(s => document.querySelectorAll(s).length, sel).catch(() => 0);
      if (n >= catalog.items.length) {
        catalog = { ...catalog, selector: sel };
        log(`章节切换回退：使用 DOM 选择器 ${sel}（${n} 项）`, 'warn');
        break;
      }
    }
  }
  if (!catalog.selector) return false;
  const clicked = await frame.evaluate(({ selector, index }) => {
    const items = Array.from(document.querySelectorAll(selector)).filter(el => el.offsetParent !== null);
    const item = items[index];
    if (!item) return false;
    item.scrollIntoView({ block: 'center' });
    item.click();
    return true;
  }, { selector: catalog.selector, index }).catch(() => false);
  // 章节切换后播放器需要时间初始化，等短了会被误判成"视频消失"
  if (clicked) await sleep(8000);
  return clicked;
}

async function getLearningState(page) {
  const states = [];
  for (const frame of page.frames()) {
    if (/7moor|moor_chat|webchat/i.test(frame.url())) continue;
    try {
      const state = await frame.evaluate(() => {
        // 放宽 video 选取：播放器重建元素/祖先 fixed 定位时 offsetParent 会为 null，
        // 只要 DOM 里存在 video 就认，否则会被误判成"视频消失"进而无谓刷新页面。
        const all = Array.from(document.querySelectorAll('video'));
        const visible = all.filter(v => v.offsetParent !== null || v.clientWidth > 0);
        const video = visible[0] || all[0] || null;
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
  // 混合架构：播放/加速交给页面内常驻助手 window.__TBH__，
  // 这里只做三件事：① 确保助手在跑 ② 只读状态 ③ 判断完成/超时。
  // 不再操作 video DOM、不再 page.reload()——这两者正是此前所有异常的根因。
  const startedAt = Date.now();
  let sawVideo = false;
  let sawDoc = false;
  let noGateRounds = 0;
  let lastLogAt = 0;
  let completedRetries = 0;
  let lastNudgeAt = 0;
  // getChapterCatalog 会遍历所有 frame，很重——节流到 12s 一次，
  // 完成判定主要由页面内助手负责，这里只是最终确认。
  let lastCatalogCheckAt = 0;

  // 音频/视频章节切换后播放器要几秒才挂载。过早启动助手会让它找不到 audio/video
  // 而退化成推 recordTime —— 平台不认这条路径（章节进度不涨）。先等播放器就绪。
  for (let i = 0; i < 12; i++) {
    const hasMedia = await page.evaluate(() => document.querySelectorAll('video, audio').length > 0).catch(() => false);
    if (hasMedia) break;
    await sleep(1500);
  }

  // 播放器可能挂在 iframe 里（"商业数据分析五部曲" 就是 video 在 iframe、主文档查不到）。
  // 必须在每个 frame 里都启动助手，读状态时也要聚合所有 frame。
  const visibleFrames = async () => page.frames().filter(f => !/7moor|moor_chat|webchat/i.test(f.url()));

  // 对所有 frame 里的助手下达同一个指令（stop / reset / setRate）
  const helperAll = async (fn, arg) => {
    for (const frame of await visibleFrames()) {
      await frame.evaluate(fn, arg).catch(() => {});
    }
  };

  const ensureHelper = async () => {
    const frames = await visibleFrames();
    let any = false;
    for (const frame of frames) {
      const ok = await frame.evaluate(r => {
        if (!window.__TBH__) return false;
        window.__TBH__.start(r);
        return true;
      }, rate).catch(() => false);
      if (ok) any = true;
    }
    if (!any) {
      await installStudyHelper(page);
      for (const frame of await visibleFrames()) {
        await frame.evaluate(r => window.__TBH__ && window.__TBH__.start(r), rate).catch(() => {});
      }
    }
  };
  await ensureHelper();

  while (Date.now() - startedAt < 20 * 60 * 1000) {
    // ① 平台章节 finished 标记是最权威的完成信号（节流检查）
    if (Date.now() - lastCatalogCheckAt > 12000) {
      lastCatalogCheckAt = Date.now();
      const catalog = await getChapterCatalog(page);
      const freshChapter = catalog.items.find(item =>
        (chapter.resourceId && item.resourceId === chapter.resourceId) ||
        (!chapter.resourceId && item.index === chapter.index)
      );
      if (freshChapter?.finished) {
        await helperAll(() => window.__TBH__ && window.__TBH__.stop());
        return { ok: true, mode: sawVideo ? 'video' : (sawDoc ? 'document' : 'unknown'), reason: 'platform_finish_flag' };
      }
    }

    // ② 只读快照：跨 frame 聚合，优先取"真在跑且有学习对象"的那个
    let snap = null;
    {
      const frames = await visibleFrames();
      const snaps = [];
      for (const frame of frames) {
        const s = await frame.evaluate(() => (window.__TBH__ ? window.__TBH__.snapshot() : null)).catch(() => null);
        if (s) snaps.push(s);
      }
      const score = s => (s.mode === 'video' ? 100 : 0) + (s.mode === 'document' ? 50 : 0) + (s.running ? 10 : 0) + s.ticks / 1000;
      snap = snaps.sort((a, b) => score(b) - score(a))[0] || null;
    }
    if (!snap || !snap.running) {
      // 助手没在跑（导航后 __TBH__ 被重建，interval 丢失）→ 重新启动
      noGateRounds++;
      if (noGateRounds >= 2) await ensureHelper();
      await sleep(2000);
      continue;
    }
    noGateRounds = 0;
    if (snap.mode === 'video') sawVideo = true;
    if (snap.mode === 'document') sawDoc = true;

    // ③ 助手判定完成
    if (snap.completed) {
      await sleep(4000);
      const recheck = await getChapterCatalog(page);
      const done = recheck.items.find(item =>
        (chapter.resourceId && item.resourceId === chapter.resourceId) ||
        (!chapter.resourceId && item.index === chapter.index)
      );
      if (done?.finished) {
        await helperAll(() => window.__TBH__ && window.__TBH__.stop());
        return { ok: true, mode: snap.mode || 'unknown', reason: snap.completedReason || 'helper_completed' };
      }
      // 助手说完成但平台不打标记：重试有限次后按完成处理，
      // 否则会陷入"reset → 又立刻 completed → 再 recheck"的死循环（曾卡在 recordTime 750 不动）
      completedRetries++;
      if (completedRetries >= 3) {
        log(`章节 ${chapter.index + 1} 助手判定完成但平台未标记，按完成处理继续下一章`, 'warn');
        await helperAll(() => window.__TBH__ && window.__TBH__.stop());
        return { ok: true, mode: snap.mode || 'unknown', reason: `${snap.completedReason || 'helper_completed'}_unconfirmed` };
      }
      await helperAll(() => window.__TBH__ && window.__TBH__.reset());
      await sleep(3000);
      continue;
    }

    // ④ 兜底：停滞救援。先降速；仍无进展则由助手内部 seek/重启（下限 2x，1x 会被平台自动 pause）
    if (snap.sinceAdvanceMs > 60000 && snap.rate > 2) {
      const next = Math.max(2, Math.floor(snap.rate / 2));
      await helperAll(r => window.__TBH__ && window.__TBH__.setRate(r), next);
      log(`  ↳ ${Math.round(snap.sinceAdvanceMs / 1000)}s 无进展，降速至 ${next}x`, 'warn');
    }
    if (snap.sinceAdvanceMs > 45000 && Date.now() - lastNudgeAt > 60000) {
      lastNudgeAt = Date.now();
      const acts = await Promise.all((await visibleFrames()).map(f =>
        f.evaluate(() => (window.__TBH__ ? window.__TBH__.nudge() : null)).catch(() => null)
      ));
      log(`  ↳ ${Math.round(snap.sinceAdvanceMs / 1000)}s 无进展，执行停滞救援：${acts.find(a => a && a !== 'no_media') || 'no_media'}`, 'warn');
    }

    if (Date.now() - lastLogAt > 6000) {
      lastLogAt = Date.now();
      if (snap.mode === 'video' && snap.video) {
        const pct = snap.video.dur > 0 ? Math.round(snap.video.cur / snap.video.dur * 100) : 0;
        log(`章节 ${chapter.index + 1} 视频 ${pct}% (${snap.video.cur}/${snap.video.dur}s) rate=${snap.video.rate} 续播=${snap.resumes} 重设=${snap.rateResets}`);
      } else if (snap.mode === 'document' && snap.doc) {
        log(`章节 ${chapter.index + 1} 文档 recordTime ${snap.doc.recordTime}/${snap.doc.minStudyTime}s (推进 ${snap.docTicks} 次)`);
      } else {
        log(`章节 ${chapter.index + 1} 等待学习对象… (ticks=${snap.ticks})`, 'warn');
      }
    }
    await sleep(3000);
  }
  await helperAll(() => window.__TBH__ && window.__TBH__.stop());
  return { ok: false, mode: sawVideo ? 'video' : (sawDoc ? 'document' : 'unknown'), reason: 'chapter_timeout' };
}

async function learnAllChapters(page, rate) {
  // 平台可能已判定学习阶段完成并直接停在评估页（"恭喜您已经完成课程学习，请完成课程评估"）。
  // 此时既没有章节目录也没有视频，必须识别出来并跳过，否则会误报 no_learning_gate。
  const learningDone = async () => page.evaluate(() =>
    /恭喜您已经完成课程学习|已完成课程学习|请完成课程评估|课程学习已完成/.test(document.body?.innerText || '')
  );
  if (await learningDone()) {
    log('平台已判定课程学习完成，跳过章节学习，直接进入评估', 'success');
    emit('learning_already_complete', {});
    return true;
  }

  let catalog = await getChapterCatalog(page);
  if (catalog.items.length === 0) {
    if (await learningDone()) {
      log('未发现章节目录，但平台已判定学习完成，直接进入评估', 'success');
      emit('learning_already_complete', { via: 'no_catalog' });
      return true;
    }
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
    let chapter = catalog.items[index];
    // 章节切换后目录会短暂消失/重渲染，别直接判失败——重新展开目录重试
    for (let retry = 1; retry <= 3 && !chapter; retry++) {
      log(`章节 ${index + 1} 暂不在目录中，第 ${retry} 次重试展开目录`, 'warn');
      await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('button, a, div, span, li')).find(
          x => (x.textContent || '').trim() === '目录' && x.children.length === 0 && x.offsetParent !== null);
        if (el) el.click();
      });
      await sleep(3000);
      catalog = await getChapterCatalog(page);
      chapter = catalog.items[index];
    }
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
async function runAll(keyword, rate = 4) {
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
// 倍速诊断：复用已验证的 login → 课表 → 点卡 链路，
// 在第一章对比 1x / 4x 下 currentTime 的真实前进量，并探测 aliplayer 官方 API
// 用法: node agent.js diag-rate <关键词> [每档观测秒数]
// ============================================================

const PROBE_FN = () => {
  const found = [];
  const names = ['player', 'aliPlayer', 'aliplayer', 'videoPlayer', 'myPlayer', '__player'];
  for (const n of names) {
    try {
      const obj = window[n];
      if (obj && typeof obj === 'object') {
        const api = Object.getOwnPropertyNames(Object.getPrototypeOf(obj) || {});
        found.push({
          name: n,
          hasSetSpeed: typeof obj.setSpeed === 'function',
          hasSeek: typeof obj.seek === 'function',
          hasGetCurrentTime: typeof obj.getCurrentTime === 'function',
          speedNow: typeof obj.getSpeed === 'function' ? (obj.getSpeed() ?? null) : null,
          curTime: typeof obj.getCurrentTime === 'function' ? (obj.getCurrentTime() ?? null) : null,
          apiSample: api.slice(0, 40),
        });
      }
    } catch {}
  }
  const videos = Array.from(document.querySelectorAll('video')).map(v => ({
    cur: +v.currentTime.toFixed(1), dur: +(v.duration || 0).toFixed(1),
    rate: v.playbackRate, paused: v.paused, rs: v.readyState, ns: v.networkState,
    src: (v.currentSrc || v.src || '').slice(0, 50),
  }));
  return { windowPlayers: found, videos };
};

const SET_RATE_DIRECT = (r) => {
  const all = Array.from(document.querySelectorAll('video'));
  const v = all.find(x => x.offsetParent !== null || x.clientWidth > 0) || all[0];
  if (!v) return false;
  v.muted = true;
  v.playbackRate = r;
  if (v.paused && !v.ended) v.play().catch(() => {});
  return true;
};

const GET_VIDEO_FN = () => {
  const all = Array.from(document.querySelectorAll('video'));
  const v = all.find(x => x.offsetParent !== null || x.clientWidth > 0) || all[0];
  if (!v) return null;
  return {
    cur: +v.currentTime.toFixed(1), dur: +(v.duration || 0).toFixed(1),
    rate: v.playbackRate, paused: v.paused, rs: v.readyState,
  };
};

async function diagRate(keyword, observeSec = 30) {
  loadEnv();
  const browser = await launchBrowser(false);
  try {
    const courseListPage = await getOrCreatePage(browser);
    await ensureLoggedIn(courseListPage);
    const courses = await scrapeCourses(courseListPage);
    const course = courses.find(item => item.title.includes(keyword));
    if (!course) throw new Error(`No matching course: ${keyword}`);
    log(`匹配课程: ${course.title} (${course.progress})`);
    const coursePage = await openCoursePage(browser, courseListPage, course);

    for (const f of coursePage.frames()) {
      if (/7moor|moor_chat/i.test(f.url())) continue;
      try {
        const probe = await f.evaluate(PROBE_FN);
        if (probe.windowPlayers.length || probe.videos.length) {
          log(`FRAME ${f.url().slice(0, 60)}`);
          log(`  players: ${JSON.stringify(probe.windowPlayers)}`);
          log(`  videos : ${JSON.stringify(probe.videos)}`);
          emit('diag_probe', { frameUrl: f.url().slice(0, 120), ...probe });
        }
      } catch {}
    }

    for (const rate of [1, 4]) {
      const ok = await coursePage.evaluate(SET_RATE_DIRECT, rate).catch(() => false);
      log(`===== 设为 ${rate}x (成功=${ok}) =====`);
      const start = await coursePage.evaluate(GET_VIDEO_FN).catch(() => null);
      log(`  起点: ${JSON.stringify(start)}`);
      let last = start ? start.cur : 0;
      const t0 = Date.now();
      for (let i = 0; i < Math.ceil(observeSec / 5); i++) {
        await sleep(5000);
        const v = await coursePage.evaluate(GET_VIDEO_FN).catch(() => null);
        if (!v) { log(`  [${i}] 无 video 元素`); continue; }
        const d = v.cur - last; last = v.cur;
        log(`  [${i}] cur=${v.cur}/${v.dur} rate=${v.rate} Δ=${d.toFixed(1)}s rs=${v.rs} paused=${v.paused}`);
      }
      const wall = (Date.now() - t0) / 1000;
      const net = last - (start ? start.cur : 0);
      log(`  ⇒ ${rate}x 观测 ${wall.toFixed(0)}s，净前进 ${net.toFixed(1)}s（有效倍速 ${(net / wall).toFixed(2)}x）`);
      emit('diag_rate_result', { rate, wallSec: +wall.toFixed(1), netSec: +net.toFixed(1), effectiveRate: +(net / wall).toFixed(2) });
    }
  } finally {
    await browser.close();
  }
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
      // 默认 4x：实测 16x/8x 会触发平台限流，currentTime 被强制回退成"进度振荡"（卡在 168s/274s）
      // 4x 实测有效倍速 3.89x 且能一路播完；1x 反而会被平台自动 pause
      const rate = rateArg >= 0 ? parseInt(args[rateArg + 1]) : 4;
      await runAll(args[1], rate);
      break;
    }
    case 'dump-eval':
      await dumpEval(args[1]);
      break;
    case 'diag-rate':
      await diagRate(args[1], parseInt(args[2] || '30'));
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
  run <keyword> [--rate N]    一键全自动完成指定课程（默认 8x）
  diag-rate <关键词> [秒数]   诊断倍速：对比 1x/4x 实际前进量 + 探测 aliplayer API
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
