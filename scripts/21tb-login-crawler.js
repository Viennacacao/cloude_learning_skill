#!/usr/bin/env node
/**
 * 21tb 云端视频学习 - 脚本1：登录 + 获取课表
 *
 * 功能：
 *   1. 自动登录 21tb 学习平台
 *   2. 导航到 "My Courses" 页面
 *   3. 抓取课程列表（名称、ID、进度、状态）
 *   4. 在浏览器中展示课表，用户可手动选择课程
 *   5. 将课程数据保存为 JSON 文件供脚本2使用
 *   6. 支持命令行参数直接启动课程（一键全自动模式）
 *
 * 用法：
 *   node 21tb-login-crawler.js                    # 交互式（登录后展示课表）
 *   node 21tb-login-crawler.js --auto             # 一键全自动（登录→显示课表→自动进入未完成课程）
 *   node 21tb-login-crawler.js --enterprise your_id --user your_user --pass your_password
 *
 * 依赖：npm install puppeteer
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { prepareEmbeddedPlayer, waitForEmbeddedPlayer, getEmbeddedPlayerState, isEvaluationPage, runEvaluationAuto, pollAndHandleEvaluation } = require('./21tb-player-embed');
const { createRunReporter } = require('./21tb-status-reporter');

// ========================
// 配置
// ========================
const CONFIG = {
  BASE_URL: 'https://v4.21tb.com',
  LOGIN_URL: 'https://v4.21tb.com/login/login.init.do',
  COURSE_CENTER_URL: 'https://v4.21tb.com/els/html/index.parser.do?id=NEW_COURSE_CENTER&current_app_id=8a80810f5ab29060015ad1906d0b3811',
  MY_COURSES_HASH: '#!/els/html/courseCenter/courseCenter.loadStudyTask.do',
  COURSE_PLAY_URL_TEMPLATE: 'https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId=',
  OUTPUT_FILE: path.join(__dirname, '..', 'course-data.json'),
  HEADLESS: false,        // 设为 true 则无头模式
  SLOW_MO: 50,            // 操作减速（ms），方便观察
  TIMEOUT: 30000,         // 页面加载超时
  PAGE_WAIT: 3000,        // 页面切换等待时间
};

// ========================
// 命令行参数解析
// ========================
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    enterprise: '',
    user: '',
    pass: '',
    courseNames: [],
    auto: false,
    autoAdvance: false,
    headless: false,
    jsonMode: false,
    progressLogsDir: '',
    autoEval: true,       // 默认开启评估自动完成
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--enterprise': case '-e': opts.enterprise = args[++i]; break;
      case '--user': case '-u': opts.user = args[++i]; break;
      case '--pass': case '-p': opts.pass = args[++i]; break;
      case '--course': case '-c': opts.courseNames.push(args[++i]); break;
      case '--auto': case '-a': opts.auto = true; break;
      case '--auto-advance': opts.autoAdvance = true; break;
      case '--no-auto-eval': opts.autoEval = false; break;
      case '--headless': opts.headless = true; break;
      case '--json': opts.jsonMode = true; break;
      case '--progress-logs': opts.progressLogsDir = args[++i] || ''; break;
      case '--help': case '-h':
        console.log(`
21tb 云端视频学习 - 登录获取课表

用法:
  node 21tb-login-crawler.js [选项]

选项:
  -e, --enterprise <id>    企业ID
  -u, --user <username>    用户名
  -p, --pass <password>    密码
  -c, --course <name>      登录后直接打开指定课程（可重复传入）
  -a, --auto               一键全自动模式（登录后自动进入第一个未完成课程）
  --auto-advance           完成当前课程后自动推进下一门未完成课程
  --no-auto-eval           禁用评估自动完成（默认开启）
  --headless               无头模式（不显示浏览器窗口）
  --json                   结构化 JSON 输出（每行一个 JSON 事件，适合 Agent/程序解析）
  --progress-logs [dir]    结构化进度日志目录（默认 cloud-video-learning/runtime-logs）
  -h, --help               显示帮助

示例:
  node 21tb-login-crawler.js -e your_id -u your_user -p your_password
  node 21tb-login-crawler.js -e your_id -u your_user -p your_password --auto
  node 21tb-login-crawler.js -e your_id -u your_user -p your_password -c "课程名"
  node 21tb-login-crawler.js -e your_id -u your_user -p your_password --auto --auto-advance --json
        `);
        process.exit(0);
    }
  }
  return opts;
}

// ========================
// 交互式输入
// ========================
function askQuestion(question, hidden = false) {
  return new Promise((resolve) => {
    if (hidden) {
      // 简单的密码输入（不回显）
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      // 在终端中隐藏密码输入
      if (process.stdout.isTTY) {
        process.stdout.write(question);
        const stdin = process.stdin;
        let password = '';
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        stdin.on('data', (char) => {
          char = char.toString();
          switch (char) {
            case '\n': case '\r': case '\u0004':
              stdin.setRawMode(false);
              stdin.pause();
              process.stdout.write('\n');
              rl.close();
              resolve(password);
              break;
            case '\u0003': // Ctrl+C
              process.exit(0);
              break;
            case '\u007f': // Backspace
              password = password.slice(0, -1);
              process.stdout.write('\b \b');
              break;
            default:
              password += char;
              process.stdout.write('*');
              break;
          }
        });
      } else {
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer);
        });
      }
    } else {
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

// ========================
// 核心逻辑
// ========================

const LOG_COLORS = {
  info: '\x1b[36m',    // cyan
  success: '\x1b[32m', // green
  warn: '\x1b[33m',    // yellow
  error: '\x1b[31m',   // red
  reset: '\x1b[0m',
};

/**
 * 步骤1：登录
 */
async function login(page, enterprise, username, password) {
  log('正在打开登录页面...', 'info');

  await page.goto(CONFIG.LOGIN_URL, {
    waitUntil: 'networkidle2',
    timeout: CONFIG.TIMEOUT,
  });
  await sleep(1500);

  // 切换到密码登录模式（默认可能是二维码登录）
  log('切换到密码登录模式...', 'info');
  let switchedToPasswordMode = false;

  // 优先调用页面内置函数切换到账号密码登录
  const switchedByBuiltin = await page.evaluate(() => {
    if (typeof noErwei === 'function') {
      noErwei();
      if (typeof changeWay === 'function') {
        const tab = document.getElementById('login-password');
        changeWay(1, tab || null);
      }
      return true;
    }
    return false;
  }).catch(() => false);

  if (switchedByBuiltin) {
    switchedToPasswordMode = true;
  }

  // 回退：点击账号登录图标或密码登录标签
  if (!switchedToPasswordMode) {
    const accountLoginBtn = await page.$('.erweima, img[onclick*="noErwei"]');
    if (accountLoginBtn) {
      try {
        await accountLoginBtn.click();
        switchedToPasswordMode = true;
      } catch (e) {
        log(`账号登录图标点击失败，改用脚本点击: ${e.message}`, 'warn');
      }
    }
  }

  if (!switchedToPasswordMode) {
    const pwdLoginBtn = await page.$('#login-password, [class*="password"], [class*="tab-pwd"], .login-tab-password, a[href*="password"]');
    if (pwdLoginBtn) {
      try {
        await pwdLoginBtn.click();
        switchedToPasswordMode = true;
      } catch (e) {
        log(`常规点击失败，改用脚本点击: ${e.message}`, 'warn');
      }
    }
  }

  if (!switchedToPasswordMode) {
    const clickedByScript = await page.evaluate(() => {
      const candidates = document.querySelectorAll('a, button, div, span, li, img');
      for (const el of candidates) {
        const text = (el.textContent || '').trim();
        const className = typeof el.className === 'string' ? el.className.toLowerCase() : '';
        const href = (el.getAttribute('href') || '').toLowerCase();
        const onclick = (el.getAttribute('onclick') || '').toLowerCase();
        if (
          onclick.includes('noerwei') ||
          text.includes('Password login') ||
          text.includes('密码登录') ||
          text.includes('sign in') ||
          className.includes('erweima') ||
          className.includes('password') ||
          className.includes('tab-pwd') ||
          href.includes('password')
        ) {
          el.click();
          return true;
        }
      }
      return false;
    });

    if (clickedByScript) {
      switchedToPasswordMode = true;
    }
  }

  if (switchedToPasswordMode) {
    await sleep(1000);
  }

  // 填写企业ID
  log(`填写企业ID: ${enterprise}`, 'info');
  await page.evaluate((val) => {
    // 使用 jQuery 方式设置值（平台用 jQuery 读取）
    if (typeof $ !== 'undefined' && $('#corpCode').length) {
      $('#corpCode').val(val);
    }
    // 同时尝试原生方式
    const input = document.querySelector('#corpCode');
    if (input) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, enterprise);
  await sleep(500);

  // 填写用户名
  log(`填写用户名: ${username}`, 'info');
  await page.evaluate((val) => {
    const jqInput = (typeof $ !== 'undefined' && $('#loginName').length)
      ? $('#loginName')
      : ((typeof $ !== 'undefined' && $('#username').length) ? $('#username') : null);
    if (jqInput) {
      jqInput.val(val);
    }
    const input = document.querySelector('#loginName, #username');
    if (input) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    }
  }, username);
  await sleep(500);

  // 填写密码
  log('填写密码: ****', 'info');
  await page.evaluate((val) => {
    const jqInput = (typeof $ !== 'undefined' && $('#swInput').length)
      ? $('#swInput')
      : ((typeof $ !== 'undefined' && $('#password').length) ? $('#password') : null);
    if (jqInput) {
      jqInput.val(val);
    }
    const input = document.querySelector('#swInput, #password');
    if (input) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    }
  }, password);
  await sleep(500);

  // 点击登录按钮
  log('点击登录按钮...', 'info');
  await page.evaluate(() => {
    const submitBtn = document.querySelector('.login-btn, #submit, button[type="submit"], .submit-btn');
    if (submitBtn) submitBtn.click();
  });
  await sleep(3000);

  // 检查是否登录成功
  const currentUrl = page.url();
  if (currentUrl.includes('login')) {
    // 可能有"继续登录"确认弹窗
    log('检测到可能的确认弹窗...', 'warn');
    const hasPopup = await page.evaluate(() => {
      const btns = document.querySelectorAll('button, a, .btn, .ant-btn');
      for (const btn of btns) {
        const text = btn.textContent.trim();
        if (text.includes('继续登录') || text.includes('Continue') || text.includes('确认') || text.includes('Confirm')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (hasPopup) {
      log('已点击确认按钮', 'info');
      await sleep(3000);
    }
  }

  // 再次检查
  const finalUrl = page.url();
  if (finalUrl.includes('login')) {
    throw new Error('登录失败，请检查企业ID、用户名和密码是否正确');
  }

  log('✅ 登录成功！', 'success');
  return true;
}

/**
 * 步骤2：导航到 My Courses 页面
 */
async function navigateToMyCourses(page) {
  log('正在导航到课程中心...', 'info');

  // 先打开课程中心首页
  await page.goto(CONFIG.COURSE_CENTER_URL, {
    waitUntil: 'networkidle2',
    timeout: CONFIG.TIMEOUT,
  });
  await sleep(CONFIG.PAGE_WAIT);

  // 点击 "My Courses" 链接
  log('点击 "My Courses"...', 'info');
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
    await sleep(CONFIG.PAGE_WAIT);
  } else {
    // 直接导航到 My Courses URL
    log('直接导航到 My Courses 页面...', 'warn');
    await page.goto(CONFIG.COURSE_CENTER_URL + CONFIG.MY_COURSES_HASH, {
      waitUntil: 'networkidle2',
      timeout: CONFIG.TIMEOUT,
    });
    await sleep(CONFIG.PAGE_WAIT);
  }

  log('✅ 已进入 My Courses 页面', 'success');
}

/**
 * 步骤3：抓取课程列表（自动遍历所有分页）
 */
async function crawlCourseList(page) {
  log('正在抓取课程列表...', 'info');

  // 等待课程卡片加载
  await page.waitForSelector('.nc-mycourse-card, .course-card', { timeout: 15000 }).catch(() => {
    log('等待课程卡片超时，尝试继续...', 'warn');
  });
  await sleep(2000);

  const getPaginationMeta = async () => {
    return page.evaluate(() => {
      const pagerRoot = document.querySelector('.pager_wrap') || Array.from(document.querySelectorAll('*')).find((el) =>
        /Total\s+\d+\s+pages/i.test((el.textContent || '').replace(/\s+/g, ' ').trim())
      );
      const pagerText = (pagerRoot?.textContent || '').replace(/\s+/g, ' ').trim();
      const totalPages = Number((pagerText.match(/Total\s+(\d+)\s+pages/i) || [])[1] || 1);

      const activeEl = document.querySelector('.pager_wrap .current, .pager_wrap .active, .pager_wrap .on, .pager_wrap .selected, .ant-pagination-item-active')
        || Array.from(document.querySelectorAll('.pager_wrap a, .pager_wrap span, .pager_wrap li, .ant-pagination-item')).find((el) => {
          const cls = typeof el.className === 'string' ? el.className : '';
          return /(current|active|on|selected)/i.test(cls) && /^\d+$/.test((el.textContent || '').trim());
        });

      const currentPage = Number((activeEl?.textContent || '').trim() || 1);
      return {
        totalPages: totalPages || 1,
        currentPage: currentPage || 1,
      };
    });
  };

  const extractCurrentPage = async (pageNumber, globalOffset) => {
    return page.evaluate(({ pageNumber, globalOffset }) => {
      const cards = document.querySelectorAll('.nc-mycourse-card');
      return [...cards].map((card, index) => {
        const link = card.querySelector('a.goStudy');
        const title = card.querySelector('h3');
        const finishTag = card.querySelector('.finish-tag, .nc-finish');

        // 解析文本信息
        const fullText = card.textContent.replace(/\s+/g, ' ').trim();

        // 提取毕业条件
        let graduation = '';
        const gradMatch = fullText.match(/Graduation conditions:\s*(.*?)(?=Progress:|$)/);
        if (gradMatch) graduation = gradMatch[1].trim();

        // 提取进度
        let progress = '';
        let progressPercent = '';
        const progressMatch = fullText.match(/Progress:\s*(.*?)(?=Compulsory|Elective|Optional|Finish|$)/);
        if (progressMatch) progress = progressMatch[1].trim();

        const percentMatch = fullText.match(/(\d+)%/);
        if (percentMatch) progressPercent = percentMatch[1];

        // 提取课程类型
        let courseType = '';
        if (fullText.includes('Compulsory')) courseType = '必修';
        else if (fullText.includes('Elective')) courseType = '选修';
        else if (fullText.includes('Optional')) courseType = '可选';

        // 检查是否已完成
        const isFinished = fullText.includes('Finish') || fullText.includes('Currently completed') || !!finishTag;

        // 提取学分和学时
        let hours = '', credits = '';
        const hourMatch = fullText.match(/Hour\s*([\d.]+)/);
        if (hourMatch) hours = hourMatch[1];
        const creditMatch = fullText.match(/Credit\s*([\d.]+)/);
        if (creditMatch) credits = creditMatch[1];

        return {
          index: globalOffset + index + 1,
          page: pageNumber,
          pageIndex: index + 1,
          id: link?.dataset?.id || '',
          title: title?.textContent?.trim() || '',
          graduation,
          progress,
          progressPercent,
          courseType,
          isFinished,
          hours,
          credits,
          courseId: link?.dataset?.id || '',
        };
      });
    }, { pageNumber, globalOffset });
  };

  const goToPage = async (targetPage, previousSignature) => {
    const clickPager = async (mode = 'direct') => {
      return page.evaluate(({ pageNo, mode }) => {
        const pagerRoot = document.querySelector('.pager_wrap') || Array.from(document.querySelectorAll('*')).find((el) =>
          /Total\s+\d+\s+pages/i.test((el.textContent || '').replace(/\s+/g, ' ').trim())
        );
        if (!pagerRoot) return false;

        const candidates = Array.from(pagerRoot.querySelectorAll('a, button, span, li'));
        const directMatch = candidates.find((el) => /^\d+$/.test((el.textContent || '').trim()) && Number((el.textContent || '').trim()) === pageNo);
        const nextLike = candidates.find((el) => /next|下一页|›|»/i.test((el.textContent || '').trim()) || /next/i.test(typeof el.className === 'string' ? el.className : ''));
        const target = mode === 'next' ? nextLike : (directMatch || nextLike);
        if (!target) return false;

        const clickable = target.querySelector('a, button') || target;
        clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        if (typeof clickable.click === 'function') clickable.click();
        return true;
      }, { pageNo: targetPage, mode });
    };

    const waitForPageChange = async () => {
      await page.waitForFunction(
        ({ targetPage, previousSignature }) => {
          const activeEl = document.querySelector('.pager_wrap .current, .pager_wrap .active, .pager_wrap .on, .pager_wrap .selected, .ant-pagination-item-active');
          const activeText = (activeEl?.textContent || '').trim();
          const firstCard = document.querySelector('.nc-mycourse-card');
          const firstSignature = firstCard
            ? `${firstCard.querySelector('a.goStudy')?.dataset?.id || ''}|${firstCard.querySelector('h3')?.textContent?.trim() || ''}`
            : '';
          return activeText === String(targetPage) || (firstSignature && firstSignature !== previousSignature);
        },
        { timeout: 12000 },
        { targetPage, previousSignature }
      ).catch(() => {});

      await sleep(2000);
    };

    const clicked = await clickPager('direct');
    if (!clicked) {
      throw new Error(`无法点击第 ${targetPage} 页分页按钮`);
    }

    await waitForPageChange();

    let currentSignature = await page.evaluate(() => {
      const firstCard = document.querySelector('.nc-mycourse-card');
      return firstCard
        ? `${firstCard.querySelector('a.goStudy')?.dataset?.id || ''}|${firstCard.querySelector('h3')?.textContent?.trim() || ''}`
        : '';
    });

    if (currentSignature === previousSignature) {
      log(`第 ${targetPage} 页直达点击没有翻过去，改用下一页按钮补一脚`, 'warn');
      const clickedNext = await clickPager('next');
      if (!clickedNext) {
        throw new Error(`第 ${targetPage} 页翻页失败，且找不到下一页按钮`);
      }
      await waitForPageChange();
      currentSignature = await page.evaluate(() => {
        const firstCard = document.querySelector('.nc-mycourse-card');
        return firstCard
          ? `${firstCard.querySelector('a.goStudy')?.dataset?.id || ''}|${firstCard.querySelector('h3')?.textContent?.trim() || ''}`
          : '';
      });
    }

    if (currentSignature === previousSignature) {
      throw new Error(`翻到第 ${targetPage} 页失败，页面内容没有变化`);
    }
  };

  const { totalPages } = await getPaginationMeta();
  const allCourses = [];

  for (let targetPage = 1; targetPage <= totalPages; targetPage++) {
    if (targetPage > 1) {
      const previousSignature = await page.evaluate(() => {
        const firstCard = document.querySelector('.nc-mycourse-card');
        return firstCard
          ? `${firstCard.querySelector('a.goStudy')?.dataset?.id || ''}|${firstCard.querySelector('h3')?.textContent?.trim() || ''}`
          : '';
      });
      await goToPage(targetPage, previousSignature);
    }

    const currentPage = targetPage;
    const pageCourses = await extractCurrentPage(currentPage, allCourses.length);
    log(`第 ${currentPage}/${totalPages} 页抓取到 ${pageCourses.length} 门课程`, 'info');
    allCourses.push(...pageCourses);
  }

  const dedupedCourses = [];
  const seenIds = new Set();
  for (const course of allCourses) {
    const key = course.id || `${course.page}-${course.pageIndex}-${course.title}`;
    if (seenIds.has(key)) continue;
    seenIds.add(key);
    dedupedCourses.push({
      ...course,
      index: dedupedCourses.length + 1,
    });
  }

  log(`✅ 成功抓取 ${dedupedCourses.length} 门课程（共 ${totalPages} 页）`, 'success');
  return dedupedCourses;
}

/**
 * 步骤4：在浏览器中展示课表（注入UI）
 */
async function displayCourseTable(page, courses) {
  log('正在生成课表展示页面...', 'info');

  await page.evaluate((courseData) => {
    // 移除已存在的面板
    const existing = document.getElementById('tbh-course-panel');
    if (existing) existing.remove();
    const existingStyle = document.getElementById('tbh-course-style');
    if (existingStyle) existing.remove();

    // 注入样式
    const style = document.createElement('style');
    style.id = 'tbh-course-style';
    style.textContent = `
      #tbh-course-panel {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 999999;
        width: 900px;
        max-height: 80vh;
        background: rgba(22, 22, 28, 0.98);
        backdrop-filter: blur(20px);
        border-radius: 16px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #e0e0e0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      #tbh-course-panel * { box-sizing: border-box; }
      .tbh-cp-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 24px;
        background: rgba(255, 255, 255, 0.05);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        flex-shrink: 0;
      }
      .tbh-cp-title {
        font-size: 18px;
        font-weight: 700;
        color: #fff;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .tbh-cp-title .icon { font-size: 20px; }
      .tbh-cp-close {
        width: 32px; height: 32px;
        border: none; border-radius: 8px;
        background: rgba(255, 255, 255, 0.1);
        color: #999; cursor: pointer;
        font-size: 16px;
        display: flex; align-items: center; justify-content: center;
        transition: all 0.2s;
      }
      .tbh-cp-close:hover { background: rgba(255, 77, 79, 0.3); color: #ff4d4f; }
      .tbh-cp-stats {
        display: flex;
        gap: 20px;
        padding: 12px 24px;
        background: rgba(255, 255, 255, 0.03);
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        flex-shrink: 0;
      }
      .tbh-cp-stat {
        font-size: 13px;
        color: #999;
      }
      .tbh-cp-stat span {
        font-weight: 700;
        font-size: 16px;
        margin-right: 4px;
      }
      .tbh-cp-stat span.total { color: #1677ff; }
      .tbh-cp-stat span.finished { color: #52c41a; }
      .tbh-cp-stat span.unfinished { color: #faad14; }
      .tbh-cp-body {
        flex: 1;
        overflow-y: auto;
        padding: 8px 0;
      }
      .tbh-cp-body::-webkit-scrollbar { width: 6px; }
      .tbh-cp-body::-webkit-scrollbar-track { background: transparent; }
      .tbh-cp-body::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: 3px; }
      .tbh-cp-course {
        display: flex;
        align-items: center;
        padding: 12px 24px;
        gap: 16px;
        transition: background 0.2s;
        cursor: pointer;
      }
      .tbh-cp-course:hover { background: rgba(255, 255, 255, 0.05); }
      .tbh-cp-course.selected { background: rgba(22, 119, 255, 0.1); }
      .tbh-cp-idx {
        width: 32px; height: 32px;
        border-radius: 8px;
        display: flex; align-items: center; justify-content: center;
        font-size: 13px; font-weight: 600;
        background: rgba(255, 255, 255, 0.06);
        color: #666;
        flex-shrink: 0;
      }
      .tbh-cp-course.is-finished .tbh-cp-idx { background: rgba(82, 196, 26, 0.15); color: #52c41a; }
      .tbh-cp-course.has-progress .tbh-cp-idx { background: rgba(250, 173, 20, 0.15); color: #faad14; }
      .tbh-cp-info { flex: 1; min-width: 0; }
      .tbh-cp-name {
        font-size: 14px;
        font-weight: 500;
        color: #e0e0e0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 4px;
      }
      .tbh-cp-meta {
        display: flex;
        gap: 12px;
        font-size: 12px;
        color: #666;
      }
      .tbh-cp-meta .tag {
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 11px;
      }
      .tbh-cp-meta .tag-finished { background: rgba(82, 196, 26, 0.15); color: #52c41a; }
      .tbh-cp-meta .tag-progress { background: rgba(250, 173, 20, 0.15); color: #faad14; }
      .tbh-cp-meta .tag-notstarted { background: rgba(255, 255, 255, 0.06); color: #666; }
      .tbh-cp-progress-bar {
        width: 80px; height: 4px;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 2px;
        overflow: hidden;
        flex-shrink: 0;
      }
      .tbh-cp-progress-fill {
        height: 100%;
        border-radius: 2px;
        background: linear-gradient(90deg, #1677ff, #4096ff);
        transition: width 0.3s;
      }
      .tbh-cp-progress-fill.done { background: linear-gradient(90deg, #52c41a, #73d13d); }
      .tbh-cp-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 24px;
        background: rgba(255, 255, 255, 0.05);
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        flex-shrink: 0;
        gap: 12px;
      }
      .tbh-cp-selected-info {
        font-size: 13px;
        color: #999;
      }
      .tbh-cp-selected-info span { color: #1677ff; font-weight: 600; }
      .tbh-cp-actions { display: flex; gap: 10px; }
      .tbh-cp-btn {
        padding: 8px 20px;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
      }
      .tbh-cp-btn.primary {
        background: linear-gradient(135deg, #1677ff, #4096ff);
        color: #fff;
      }
      .tbh-cp-btn.primary:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(22, 119, 255, 0.4); }
      .tbh-cp-btn.primary:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }
      .tbh-cp-btn.secondary {
        background: rgba(255, 255, 255, 0.08);
        color: #999;
      }
      .tbh-cp-btn.secondary:hover { background: rgba(255, 255, 255, 0.15); color: #e0e0e0; }
      .tbh-cp-input {
        padding: 8px 14px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.05);
        color: #e0e0e0;
        font-size: 13px;
        width: 250px;
        outline: none;
        transition: border-color 0.2s;
      }
      .tbh-cp-input:focus { border-color: #1677ff; }
      .tbh-cp-input::placeholder { color: #555; }
      .tbh-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 999998;
      }
    `;
    document.head.appendChild(style);

    // 遮罩层
    const overlay = document.createElement('div');
    overlay.className = 'tbh-overlay';
    overlay.id = 'tbh-course-overlay';
    document.body.appendChild(overlay);

    // 创建面板
    const panel = document.createElement('div');
    panel.id = 'tbh-course-panel';

    const total = courseData.length;
    const finished = courseData.filter(c => c.isFinished).length;
    const unfinished = total - finished;

    panel.innerHTML = `
      <div class="tbh-cp-header">
        <div class="tbh-cp-title">
          <span class="icon">📚</span>
          我的课程列表
        </div>
        <button class="tbh-cp-close" id="tbhCpClose">✕</button>
      </div>
      <div class="tbh-cp-stats">
        <div class="tbh-cp-stat"><span class="total">${total}</span>门课程</div>
        <div class="tbh-cp-stat"><span class="finished">${finished}</span>已完成</div>
        <div class="tbh-cp-stat"><span class="unfinished">${unfinished}</span>未完成</div>
      </div>
      <div class="tbh-cp-body" id="tbhCpBody">
        ${courseData.map(c => `
          <div class="tbh-cp-course ${c.isFinished ? 'is-finished' : ''} ${c.progressPercent && !c.isFinished ? 'has-progress' : ''}"
               data-id="${c.id}" data-index="${c.index}">
            <div class="tbh-cp-idx">${c.isFinished ? '✓' : c.index}</div>
            <div class="tbh-cp-info">
              <div class="tbh-cp-name" title="${c.title}">${c.title}</div>
              <div class="tbh-cp-meta">
                <span>${c.courseType || '其他'}</span>
                <span>${c.hours ? c.hours + '学时' : ''}</span>
                <span>${c.graduation || ''}</span>
                <span class="tag ${c.isFinished ? 'tag-finished' : c.progressPercent ? 'tag-progress' : 'tag-notstarted'}">${c.isFinished ? '已完成' : c.progressPercent ? c.progressPercent + '%' : '未开始'}</span>
              </div>
            </div>
            <div class="tbh-cp-progress-bar">
              <div class="tbh-cp-progress-fill ${c.isFinished ? 'done' : ''}" style="width: ${c.isFinished ? 100 : (parseInt(c.progressPercent) || 0)}%"></div>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="tbh-cp-footer">
        <div class="tbh-cp-selected-info" id="tbhCpSelected">点击课程进行选择（支持多选）</div>
        <div class="tbh-cp-actions">
          <input class="tbh-cp-input" id="tbhCpInput" placeholder="输入课程名称或编号搜索..." />
          <button class="tbh-cp-btn secondary" id="tbhCpSelectAll">全选未完成</button>
          <button class="tbh-cp-btn primary" id="tbhCpLaunch" disabled>启动学习</button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    // 交互逻辑
    const selectedCourses = new Set();

    // 点击课程项
    document.getElementById('tbhCpBody').addEventListener('click', (e) => {
      const courseEl = e.target.closest('.tbh-cp-course');
      if (!courseEl) return;

      const id = courseEl.dataset.id;
      if (selectedCourses.has(id)) {
        selectedCourses.delete(id);
        courseEl.classList.remove('selected');
      } else {
        selectedCourses.add(id);
        courseEl.classList.add('selected');
      }
      updateSelectedInfo();
    });

    function updateSelectedInfo() {
      const info = document.getElementById('tbhCpSelected');
      const launchBtn = document.getElementById('tbhCpLaunch');
      if (selectedCourses.size === 0) {
        info.innerHTML = '点击课程进行选择（支持多选）';
        launchBtn.disabled = true;
      } else {
        const names = [...selectedCourses].map(id => {
          const c = courseData.find(x => x.id === id);
          return c ? c.title : id;
        });
        info.innerHTML = `已选择 <span>${selectedCourses.size}</span> 门课程`;
        launchBtn.disabled = false;
      }
    }

    // 搜索
    document.getElementById('tbhCpInput').addEventListener('input', (e) => {
      const keyword = e.target.value.toLowerCase().trim();
      const courses = document.querySelectorAll('.tbh-cp-course');
      courses.forEach(el => {
        const id = el.dataset.id;
        const course = courseData.find(c => c.id === id);
        if (!keyword) {
          el.style.display = '';
        } else {
          const match = course.title.toLowerCase().includes(keyword) ||
                        String(course.index).includes(keyword) ||
                        course.courseType.includes(keyword);
          el.style.display = match ? '' : 'none';
        }
      });
    });

    // 全选未完成
    document.getElementById('tbhCpSelectAll').addEventListener('click', () => {
      selectedCourses.clear();
      document.querySelectorAll('.tbh-cp-course').forEach(el => {
        const id = el.dataset.id;
        const course = courseData.find(c => c.id === id);
        if (!course.isFinished) {
          selectedCourses.add(id);
          el.classList.add('selected');
        } else {
          el.classList.remove('selected');
        }
      });
      updateSelectedInfo();
    });

    // 关闭
    document.getElementById('tbhCpClose').addEventListener('click', () => {
      document.getElementById('tbh-course-panel').remove();
      document.getElementById('tbh-course-overlay').remove();
    });
    document.getElementById('tbh-course-overlay').addEventListener('click', () => {
      document.getElementById('tbh-course-panel').remove();
      document.getElementById('tbh-course-overlay').remove();
    });

    // 启动按钮 - 将选择存入 window 供外部读取
    document.getElementById('tbhCpLaunch').addEventListener('click', () => {
      window.__tbhSelectedCourses = [...selectedCourses];
      // 触发自定义事件
      document.dispatchEvent(new CustomEvent('tbh-launch-courses', {
        detail: { courseIds: [...selectedCourses] }
      }));
    });
  }, courses);

  log('✅ 课表面板已展示在浏览器中', 'success');
  log('请在浏览器中选择课程后点击「启动学习」', 'info');
}

/**
 * 步骤5：等待用户选择课程（在浏览器UI中操作）
 */
async function waitForUserSelection(page, timeout = 600000) {
  // 10 分钟超时
  log('等待用户在浏览器中选择课程...', 'info');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('等待用户选择超时（10分钟）'));
    }, timeout);

    // 监听自定义事件
    page.exposeFunction('tbhOnLaunch', (courseIds) => {
      clearTimeout(timer);
      resolve(courseIds);
    });

    // 注入事件监听
    page.evaluate(() => {
      document.addEventListener('tbh-launch-courses', (e) => {
        if (typeof window.tbhOnLaunch === 'function') {
          window.tbhOnLaunch(e.detail.courseIds);
        }
      });
    });
  });
}

/**
 * 步骤6：保存课程数据
 */
async function saveCourseData(courses) {
  const data = {
    updateTime: new Date().toISOString(),
    baseUrl: CONFIG.BASE_URL,
    coursePlayUrlTemplate: CONFIG.COURSE_PLAY_URL_TEMPLATE,
    courses,
  };

  fs.writeFileSync(CONFIG.OUTPUT_FILE, JSON.stringify(data, null, 2), 'utf-8');
  log(`课程数据已保存到: ${CONFIG.OUTPUT_FILE}`, 'success');
  return CONFIG.OUTPUT_FILE;
}

/**
 * 一键全自动模式：自动选择第一个未完成的课程
 */
function autoSelectCourse(courses) {
  const unfinished = courses.filter(c => !c.isFinished);
  if (unfinished.length === 0) {
    log('🎉 所有课程都已完成！', 'success');
    return [];
  }
  log(`自动选择第一个未完成课程: ${unfinished[0].title}`, 'info');
  return [unfinished[0].id];
}

function matchCoursesByName(courses, names) {
  const matched = [];
  for (const name of names) {
    const keyword = String(name || '').trim().toLowerCase();
    if (!keyword) continue;

    const found = courses.filter((course) => course.title.toLowerCase().includes(keyword));
    if (found.length === 0) {
      log(`未找到匹配的课程: ${name}`, 'warn');
      continue;
    }

    if (found.length > 1) {
      log(`课程名“${name}”匹配到 ${found.length} 门课程，将全部打开`, 'warn');
    } else {
      log(`已匹配到课程: ${found[0].title}`, 'success');
    }

    matched.push(...found);
  }

  const unique = [];
  const seenIds = new Set();
  for (const course of matched) {
    if (seenIds.has(course.id)) continue;
    seenIds.add(course.id);
    unique.push(course);
  }
  return unique;
}

// ========================
// 工具函数
// ========================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let reporter = null;

function log(msg, level = 'info', options = {}) {
  if (reporter) {
    reporter.log(msg, level, options);
  } else {
    const time = new Date().toLocaleTimeString();
    const color = LOG_COLORS[level] || LOG_COLORS.info;
    console.log(`${color}[${time}] ${msg}${LOG_COLORS.reset}`);
  }
}

async function openCourseWithEmbeddedPlayer(page, courseUrl, courseTitle) {
  await prepareEmbeddedPlayer(page, {
    autoStart: true,
    autoStartDelayMs: 1800,
    defaultSpeed: 16,
    source: 'login-crawler',
  });

  await page.goto(courseUrl, {
    waitUntil: 'networkidle2',
    timeout: CONFIG.TIMEOUT,
  });

  const helperState = await waitForEmbeddedPlayer(page).catch(() => null);
  if (helperState) {
    log(`内置播放助手已注入：${courseTitle}（${helperState.currentSpeed}x，自动启动=${helperState.autoStart ? '是' : '否'}）`, 'success');
  } else {
    log(`课程页已打开，但未能及时确认内置播放助手状态：${courseTitle}`, 'warn');
  }
}

/**
 * 自动推进监听：当课程完成时自动打开下一门未完成课程
 */
async function watchAndAutoAdvance(page, unfinishedCourses, options = {}) {
  const {
    pollIntervalMs = 30000,
    checkDelayMs = 5000,
    onCourseStart,
    onCourseComplete,
    onAllDone,
    onProgress,
  } = options;

  let courseQueue = [...unfinishedCourses];
  let currentIndex = 0;

  const finishedSet = new Set();
  const report = (phase, payload = {}) => {
    if (reporter) {
      reporter.emit(phase, payload);
    }
  };

  while (currentIndex < courseQueue.length) {
    const course = courseQueue[currentIndex];

    if (finishedSet.has(course.id)) {
      currentIndex++;
      continue;
    }

    report('course_start', {
      courseTitle: course.title,
      courseId: course.id,
      courseIndex: currentIndex + 1,
      totalCourses: courseQueue.length,
      status: 'playing',
    });

    log(`▶ [${currentIndex + 1}/${courseQueue.length}] 正在学习：${course.title}`, 'success');
    if (onCourseStart) onCourseStart(course, currentIndex);

    // 等一会儿让注入的脚本初始化
    await sleep(checkDelayMs);

    let courseDone = false;
    let pollCount = 0;
    const maxPolls = 3600; // 最多轮询 30 小时

    while (!courseDone && pollCount < maxPolls) {
      await sleep(pollIntervalMs);
      pollCount++;

      const state = await getEmbeddedPlayerState(page).catch(() => null);

      // 检测是否进入评估页面（视频播放完毕后自动跳转）
      if (!courseDone) {
        const evalDetected = await isEvaluationPage(page).catch(() => false);
        if (evalDetected) {
          log(`📋 [${currentIndex + 1}/${courseQueue.length}] 检测到课程评估页面，自动填写并提交...`, 'info');
          
          try {
            const evalResult = await runEvaluationAuto(page);
            if (evalResult.success) {
              log(`✅ [${currentIndex + 1}/${courseQueue.length}] ${course.title}：评估已自动完成并提交！`, 'success');
              report('eval_complete', { courseTitle: course.title, courseId: course.id });
            } else {
              log(`⚠️ [${currentIndex + 1}/${courseQueue.length}] ${course.title}：评估执行异常 - ${evalResult.error || '未知错误'}`, 'warn');
            }
          } catch (evalErr) {
            log(`❌ [${currentIndex + 1}/${courseQueue.length}] ${course.title}：评估模块出错 - ${evalErr.message}`, 'error');
          }

          // 评估完成后标记课程为已完成
          courseDone = true;
        }
      }

      if (state && state.progress) {
        const p = state.progress;
        const progressPct = p.totalResources > 0
          ? Math.round((p.finishedResources / p.totalResources) * 100)
          : 0;

        log(
          `[${currentIndex + 1}/${courseQueue.length}] ${course.title}：${p.finishedResources}/${p.totalResources} 资源已完成 (${progressPct}%) | 当前：${p.currentResourceName || '加载中...'}`,
          'info'
        );

        if (onProgress) {
          onProgress(course, p);
        }

        if (reporter) {
          reporter.updateState({
            currentCourse: {
              title: course.title,
              id: course.id,
              index: currentIndex + 1,
              total: courseQueue.length,
            },
            currentCourseProgress: {
              totalResources: p.totalResources,
              finishedResources: p.finishedResources,
              percent: progressPct,
              currentResourceName: p.currentResourceName,
              courseCompleted: !!p.courseCompleted,
            },
          });
        }

        if (p.courseCompleted || p.finishedResources >= p.totalResources) {
          courseDone = true;
        }
      }

      // 备用检测：检查页面是否刷新到非课程页或出现了课程完成标识
      if (!courseDone) {
        const pageDone = await page.evaluate(() => {
          // 检查是否有课程完成标识
          const finishEl = document.querySelector('.finish-tag, .nc-finish, .course-complete');
          if (finishEl) return true;
          // 检查是否不在课程播放页了
          return false;
        }).catch(() => false);

        if (pageDone) {
          courseDone = true;
        }
      }
    }

    finishedSet.add(course.id);
    report('course_complete', {
      courseTitle: course.title,
      courseId: course.id,
      courseIndex: currentIndex + 1,
      totalCourses: courseQueue.length,
      status: 'completed',
    });

    log(`✅ [${currentIndex + 1}/${courseQueue.length}] 已完成：${course.title}`, 'success');
    if (onCourseComplete) onCourseComplete(course, currentIndex);

    currentIndex++;

    if (currentIndex >= courseQueue.length) {
      break;
    }

    // 等待并打开下一门课程
    log(`等待 5 秒后自动推进到下一门课程...`, 'info');
    await sleep(5000);

    const nextCourse = courseQueue[currentIndex];
    const nextUrl = CONFIG.COURSE_PLAY_URL_TEMPLATE + nextCourse.id;

    log(`正在打开下一门课程：${nextCourse.title}`, 'info');
    await openCourseWithEmbeddedPlayer(page, nextUrl, nextCourse.title);
  }

  report('all_courses_complete', {
    status: 'all_done',
    completedCount: finishedSet.size,
    totalCourses: courseQueue.length,
  });

  log(`🎉 全部 ${courseQueue.length} 门课程学习完毕！`, 'success');
  if (onAllDone) onAllDone(courseQueue.length);
}

// ========================
// 主流程
// ========================
async function main() {
  const opts = parseArgs();
  let enterprise = opts.enterprise;
  let username = opts.user;
  let password = opts.pass;

  // 初始化结构化上报器
  const logsDir = opts.progressLogsDir || path.join(__dirname, '..', 'runtime-logs');
  reporter = createRunReporter({
    scriptName: '21tb-login-crawler',
    jsonMode: opts.jsonMode,
    baseDir: logsDir,
  });

  if (!opts.jsonMode) {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   21tb 云端视频学习 - 登录获取课表          ║');
    console.log('║   时光易学视频助手配套工具                    ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
  } else {
    // JSON 模式下跳过 banner，直接输出结构化数据
  }

  // 如果没有提供凭据，交互式询问
  if (!enterprise) {
    enterprise = await askQuestion('请输入企业ID: ');
  }
  if (!username) {
    username = await askQuestion('请输入用户名: ');
  }
  if (!password) {
    password = await askQuestion('请输入密码: ', true);
  }

  log('正在启动浏览器...', 'info', { eventType: 'browser_launching' });

  let browser;
  let shouldCloseBrowser = !!(opts.headless || CONFIG.HEADLESS);

  browser = await puppeteer.launch({
    headless: opts.headless || CONFIG.HEADLESS,
    slowMo: CONFIG.SLOW_MO,
    defaultViewport: { width: 1440, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const page = (await browser.pages())[0];

    // 设置 User-Agent 避免检测
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // 步骤1：登录
    reporter.updateState({ phase: 'login' });
    await login(page, enterprise, username, password);
    reporter.emit('login_success', { enterprise, user: username });

    // 步骤2：导航到 My Courses
    reporter.updateState({ phase: 'navigation' });
    await navigateToMyCourses(page);

    // 步骤3：抓取课程列表
    reporter.updateState({ phase: 'crawling' });
    const courses = await crawlCourseList(page);

    if (courses.length === 0) {
      log('未找到任何课程', 'warn');
      reporter.close('no_courses');
      return;
    }

    const totalCourses = courses.length;
    const finishedCount = courses.filter(c => c.isFinished).length;
    const unfinishedCourses = courses.filter(c => !c.isFinished);
    const unfinishedCount = unfinishedCourses.length;

    reporter.updateState({
      phase: 'course_list_ready',
      totalCourses,
      finishedCourses: finishedCount,
      unfinishedCourses: unfinishedCount,
      courseList: unfinishedCourses.map((c, i) => ({
        index: i + 1,
        id: c.id,
        title: c.title,
        progress: c.isFinished ? 100 : (parseInt(c.progressPercent) || 0),
        courseType: c.courseType || '',
      })),
    });

    // 打印课表摘要到终端
    if (!opts.jsonMode) {
      console.log('');
      console.log('══════════════════════════════════════════════════');
      console.log('  课程列表摘要');
      console.log('══════════════════════════════════════════════════');
      courses.forEach(c => {
        const status = c.isFinished ? '✅' : c.progressPercent ? '🔄' : '⬜';
        const progress = c.isFinished ? '100%' : c.progressPercent || '0%';
        console.log(`  ${status} ${String(c.index).padStart(2)}. ${c.title}`);
        console.log(`      类型: ${c.courseType || '-'}  进度: ${progress}  毕业条件: ${c.graduation || '-'}`);
      });
      console.log('══════════════════════════════════════════════════');
      console.log('');
    }

    // 步骤4：保存课程数据
    await saveCourseData(courses);
    reporter.emit('course_list_saved', { totalCourses, unfinishedCourses: unfinishedCount });

    // ====================================================
    // 按课程名直达
    // ====================================================
    if (opts.courseNames.length > 0) {
      const matchedCourses = matchCoursesByName(courses, opts.courseNames);
      if (matchedCourses.length === 0) {
        log('没有匹配到指定课程，未执行开课动作', 'warn');
        reporter.close('no_match', { requestedCourses: opts.courseNames });
        return;
      }

      for (let index = 0; index < matchedCourses.length; index++) {
        const course = matchedCourses[index];
        const courseUrl = CONFIG.COURSE_PLAY_URL_TEMPLATE + course.id;
        const targetPage = index === 0 ? page : await browser.newPage();

        if (index > 0) {
          await targetPage.setUserAgent(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
          );
        }

        log(`正在打开指定课程: ${course.title}`, 'info');
        log('将使用 Skill 内置播放助手自动接管课程播放（不依赖油猴）', 'success');
        await openCourseWithEmbeddedPlayer(targetPage, courseUrl, course.title);
        reporter.emit('course_opened', {
          courseTitle: course.title,
          courseId: course.id,
          status: 'playing',
        });

        if (index < matchedCourses.length - 1) {
          await sleep(2000);
        }
      }

      if (opts.autoAdvance && matchedCourses.length === 1 && unfinishedCourses.length > 1) {
        // 如果只指定了一门课且开了自动推进，在完成这门课后继续推进其余未完成课程
        const remainingUnfinished = unfinishedCourses.filter(
          c => !matchedCourses.some(m => m.id === c.id)
        );
        if (remainingUnfinished.length > 0) {
          log(`完成当前课程后，将自动推进剩余 ${remainingUnfinished.length} 门未完成课程`, 'success');
          reporter.updateState({ phase: 'auto_advancing' });
          await watchAndAutoAdvance(page, matchedCourses.concat(remainingUnfinished), {
            onProgress: (course, progress) => {
              // 进度更新已由 watchAndAutoAdvance 内部处理
            },
          });
          reporter.close('all_done', { completedCount: matchedCourses.length + remainingUnfinished.length });
          return;
        }
      }

      reporter.updateState({ phase: 'playing' });
      log('浏览器将保持打开状态，按 Ctrl+C 退出', 'info');
      await new Promise(() => {});
      return;
    }

    // ====================================================
    // 一键全自动模式
    // ====================================================
    if (opts.auto) {
      const selectedCourse = unfinishedCourses[0];
      if (!selectedCourse) {
        log('所有课程已完成，无需启动', 'success');
        reporter.close('all_done', { completedCount: totalCourses });
        return;
      }

      const courseUrl = CONFIG.COURSE_PLAY_URL_TEMPLATE + selectedCourse.id;
      log(`正在打开课程: ${selectedCourse.title}`, 'info');
      log('将使用 Skill 内置播放助手自动接管课程播放（不依赖油猴）', 'success');
      await openCourseWithEmbeddedPlayer(page, courseUrl, selectedCourse.title);
      reporter.emit('course_opened', {
        courseTitle: selectedCourse.title,
        courseId: selectedCourse.id,
        courseIndex: 1,
        totalCourses: unfinishedCount,
        status: 'playing',
      });

      if (opts.autoAdvance && unfinishedCount > 1) {
        log(`自动推进模式已开启，完成当前课程后将自动学习剩余 ${unfinishedCount - 1} 门课程`, 'success');
        reporter.updateState({ phase: 'auto_advancing' });

        await watchAndAutoAdvance(page, unfinishedCourses, {
          pollIntervalMs: 30000,
          onProgress: (course, progress) => {
            // 状态已由 watchAndAutoAdvance 内部上报
          },
        });

        reporter.close('all_done', { completedCount: unfinishedCount });
        return;
      }

      // 非 auto-advance：保持浏览器打开
      reporter.updateState({ phase: 'playing' });
      log('浏览器将保持打开状态，按 Ctrl+C 退出', 'info');
      await new Promise(() => {});
      return;
    }

    // ====================================================
    // 无头模式：输出摘要后退出
    // ====================================================
    if (opts.headless) {
      if (opts.jsonMode) {
        const summary = {
          type: 'course_summary',
          timestamp: new Date().toISOString(),
          sessionId: reporter.sessionId,
          totalCourses,
          finishedCourses: finishedCount,
          unfinishedCourses: unfinishedCount,
          unfinishedList: unfinishedCourses.map(c => ({
            id: c.id,
            title: c.title,
            progress: parseInt(c.progressPercent) || 0,
            courseType: c.courseType || '',
          })),
          files: reporter.getState().files,
        };
        process.stdout.write(`${JSON.stringify(summary)}\n`);
      } else {
        console.log('未完成课程：');
        unfinishedCourses.forEach(c => {
          const progress = c.progressPercent ? `${c.progressPercent}%` : '0%';
          console.log(`  - [第${c.page}页 #${c.index}] ${c.title} (${progress})`);
        });
        log(`无头模式已输出 ${unfinishedCount} 门未完成课程，脚本即将退出`, 'success');
      }
      reporter.close('headless_done', { unfinishedCount });
      return;
    }

    // ====================================================
    // 交互模式：展示课表面板
    // ====================================================
    await displayCourseTable(page, courses);

    try {
      const selectedIds = await waitForUserSelection(page);
      log(`用户选择了 ${selectedIds.length} 门课程`, 'success');

      for (const courseId of selectedIds) {
        const course = courses.find(c => c.id === courseId);
        const courseUrl = CONFIG.COURSE_PLAY_URL_TEMPLATE + courseId;
        log(`正在新标签页打开课程: ${course?.title}`, 'info');

        const newPage = await browser.newPage();
        await newPage.setUserAgent(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );
        await openCourseWithEmbeddedPlayer(newPage, courseUrl, course?.title || courseId);

        if (selectedIds.indexOf(courseId) < selectedIds.length - 1) {
          await sleep(2000);
        }
      }

      log('✅ 所有选中课程已在新标签页中打开', 'success');
      log('内置播放助手已注入到每个课程页，并会自动启动播放', 'success');
    } catch (e) {
      if (e.message.includes('超时')) {
        log('用户未选择课程或已关闭面板', 'info');
      } else {
        throw e;
      }
    }

    // 保持浏览器打开
    log('浏览器将保持打开状态，按 Ctrl+C 退出', 'info');
    await new Promise(() => {}); // 永久等待

  } catch (e) {
    log(`发生错误: ${e.message}`, 'error');
    reporter.emit('error', { message: e.message, stack: e.stack }, 'error');
    reporter.close('failed', { error: e.message });
    console.error(e);
  } finally {
    if (shouldCloseBrowser && browser) {
      await browser.close().catch(() => {});
    }
  }
}

main().catch(console.error);
