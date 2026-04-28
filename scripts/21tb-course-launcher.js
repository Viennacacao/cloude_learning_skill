#!/usr/bin/env node
/**
 * 21tb 云端视频学习 - 脚本2：启动课程播放
 *
 * 功能：
 *   1. 读取脚本1保存的课表数据（course-data.json）
 *   2. 通过课程名称、编号或直接URL启动课程
 *   3. 支持同时启动多个课程（多标签页）
 *   4. 打开课程页面后，Skill 内置播放助手自动注入并接管播放
 *
 * 用法：
 *   node 21tb-course-launcher.js "课程名称1" "课程名称2"    # 通过名称启动
 *   node 21tb-course-launcher.js --url "https://v4.21tb.com/..."  # 通过URL启动
 *   node 21tb-course-launcher.js --all-unfinished              # 启动所有未完成课程
 *   node 21tb-course-launcher.js --index 1 3 5                 # 通过编号启动
 *   node 21tb-course-launcher.js --id courseId1 courseId2       # 通过课程ID启动
 *   node 21tb-course-launcher.js --interactive                 # 交互式选择
 *
 * 依赖：npm install puppeteer
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { prepareEmbeddedPlayer, injectEmbeddedPlayerIntoCurrentPage, waitForEmbeddedPlayer } = require('./21tb-player-embed');

function loadProjectEnv() {
  const envFile = path.join(__dirname, '..', '.env');
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
loadProjectEnv();

// ========================
// 配置
// ========================
const CONFIG = {
  BASE_URL: 'https://v4.21tb.com',
  COURSE_PLAY_URL_TEMPLATE: 'https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId=',
  DATA_FILE: path.join(__dirname, '..', 'course-data.json'),
  HEADLESS: false,
  TAB_DELAY: 2000,  // 打开多个课程时的间隔
};

// ========================
// 命令行参数解析
// ========================
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    names: [],
    urls: [],
    ids: [],
    indexes: [],
    allUnfinished: false,
    interactive: false,
    headless: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url': case '-l':
        opts.urls.push(args[++i]);
        break;
      case '--id': case '-i':
        opts.ids.push(args[++i]);
        break;
      case '--index':
        opts.indexes.push(parseInt(args[++i]));
        break;
      case '--all-unfinished': case '-a':
        opts.allUnfinished = true;
        break;
      case '--interactive': case '-I':
        opts.interactive = true;
        break;
      case '--headless':
        opts.headless = true;
        break;
      case '--help': case '-h':
        console.log(`
21tb 云端视频学习 - 启动课程播放

用法:
  node 21tb-course-launcher.js [选项] [课程名称...]

选项:
  -l, --url <url>          通过课程URL直接打开
  -i, --id <courseId>      通过课程ID打开
  --index <number>         通过课程编号打开（对应课表中的序号）
  -a, --all-unfinished     打开所有未完成的课程
  -I, --interactive        交互式选择课程
  --headless               无头模式
  -h, --help               显示帮助

示例:
  node 21tb-course-launcher.js "项目成本管理" "项目沟通管理"
  node 21tb-course-launcher.js --url "https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId=xxx"
  node 21tb-course-launcher.js --all-unfinished
  node 21tb-course-launcher.js --index 1 3 5
  node 21tb-course-launcher.js --id 5cd292907af72b6882f516ad35972b71
        `);
        process.exit(0);
      default:
        // 当作课程名称处理
        if (!args[i].startsWith('-')) {
          opts.names.push(args[i]);
        }
    }
  }
  return opts;
}

// ========================
// 日志
// ========================
const LOG_COLORS = {
  info: '\x1b[36m',
  success: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};

function log(msg, level = 'info') {
  const time = new Date().toLocaleTimeString();
  const color = LOG_COLORS[level] || LOG_COLORS.info;
  console.log(`${color}[${time}] ${msg}${LOG_COLORS.reset}`);
}

// ========================
// 核心逻辑
// ========================

/**
 * 加载课程数据
 */
function loadCourseData() {
  if (!fs.existsSync(CONFIG.DATA_FILE)) {
    throw new Error(`课程数据文件不存在: ${CONFIG.DATA_FILE}\n请先运行 21tb-login-crawler.js 获取课表`);
  }

  const data = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf-8'));
  log(`已加载课程数据（更新时间: ${data.updateTime}，共 ${data.courses.length} 门课程）`, 'info');
  return data;
}

/**
 * 根据名称匹配课程
 */
function matchCoursesByName(courses, names) {
  const matched = [];
  for (const name of names) {
    const keyword = name.toLowerCase();
    const found = courses.filter(c =>
      c.title.toLowerCase().includes(keyword)
    );
    if (found.length === 0) {
      log(`未找到匹配的课程: "${name}"`, 'warn');
    } else if (found.length > 1) {
      log(`"${name}" 匹配到 ${found.length} 门课程，全部打开:`, 'info');
      found.forEach(c => log(`  - ${c.title}`, 'info'));
      matched.push(...found);
    } else {
      log(`匹配到课程: ${found[0].title}`, 'success');
      matched.push(found[0]);
    }
  }
  return matched;
}

/**
 * 根据编号匹配课程
 */
function matchCoursesByIndex(courses, indexes) {
  const matched = [];
  for (const idx of indexes) {
    const course = courses.find(c => c.index === idx);
    if (!course) {
      log(`未找到编号为 ${idx} 的课程`, 'warn');
    } else {
      log(`匹配到课程 #${idx}: ${course.title}`, 'success');
      matched.push(course);
    }
  }
  return matched;
}

/**
 * 根据ID匹配课程
 */
function matchCoursesById(courses, ids) {
  const matched = [];
  for (const id of ids) {
    const course = courses.find(c => c.id === id);
    if (!course) {
      log(`未找到ID为 ${id} 的课程`, 'warn');
    } else {
      log(`匹配到课程: ${course.title}`, 'success');
      matched.push(course);
    }
  }
  return matched;
}

/**
 * 获取所有未完成课程
 */
function getUnfinishedCourses(courses) {
  return courses.filter(c => !c.isFinished);
}

/**
 * 交互式选择
 */
async function interactiveSelect(courses) {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 显示课程列表
  console.log('\n══════════════════════════════════════════════════');
  console.log('  课程列表');
  console.log('══════════════════════════════════════════════════');
  courses.forEach(c => {
    const status = c.isFinished ? '✅' : c.progressPercent ? '🔄' : '⬜';
    const progress = c.isFinished ? '100%' : c.progressPercent || '0%';
    console.log(`  ${status} ${String(c.index).padStart(2)}. ${c.title} [${progress}]`);
  });
  console.log('══════════════════════════════════════════════════');

  return new Promise((resolve) => {
    rl.question('\n请输入要启动的课程编号（多个用空格分隔），或输入 "all" 启动所有未完成课程: ', (answer) => {
      rl.close();
      const input = answer.trim();

      if (input.toLowerCase() === 'all') {
        resolve(getUnfinishedCourses(courses));
        return;
      }

      const indexes = input.split(/[\s,，]+/).map(Number).filter(n => !isNaN(n));
      resolve(matchCoursesByIndex(courses, indexes));
    });
  });
}

/**
 * 解析URL中的课程ID
 */
function extractCourseIdFromUrl(url) {
  // 匹配 courseId=xxx
  const match = url.match(/courseId=([a-f0-9]+)/i);
  if (match) return match[1];

  // 匹配路径中的ID
  const pathMatch = url.match(/\/([a-f0-9]{32})/i);
  if (pathMatch) return pathMatch[1];

  return null;
}

async function openCourseWithEmbeddedPlayer(page, target) {
  await page.goto(target.url, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // 进入课程页后再注入（满足“只在课程页面注入”的约束）
  await injectEmbeddedPlayerIntoCurrentPage(page, {
    autoStart: true,
    autoStartDelayMs: 1800,
    defaultSpeed: 16,
    source: 'course-launcher',
    autoEval: true,
    postTestEnabled: true,
    postTestRequireConfirm: String(process.env.POSTTEST_REQUIRE_CONFIRM || '').toLowerCase() === 'true',
    postTestLowConfidenceThreshold: 0.65,
    postTestAutoSubmitThreshold: 0.7,
    postTestModel: process.env.ZHIPU_MODEL || 'glm-4-flash',
    postTestApiBaseUrl: process.env.ZHIPU_API_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    postTestApiTimeoutMs: Number(process.env.POSTTEST_AI_TIMEOUT_MS) || 15000,
    zhipuApiKey: process.env.ZHIPU_API_KEY || '',
  });

  const helperState = await waitForEmbeddedPlayer(page).catch(() => null);
  if (helperState) {
    log(`✅ 已打开: ${target.title}（内置播放助手 ${helperState.currentSpeed}x 自动启动）`, 'success');
  } else {
    log(`⚠️ 已打开: ${target.title}，但暂未确认内置播放助手状态`, 'warn');
  }
}

// ========================
// 主流程
// ========================
async function main() {
  const opts = parseArgs();

  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   21tb 云端视频学习 - 启动课程播放           ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  // 收集所有要打开的课程URL
  const urlsToOpen = [];

  // 直接URL
  for (const url of opts.urls) {
    urlsToOpen.push({ url, title: 'URL指定的课程' });
  }

  // 需要加载课程数据的情况
  let courseData = null;
  const needsData = opts.names.length > 0 || opts.ids.length > 0 ||
                    opts.indexes.length > 0 || opts.allUnfinished || opts.interactive;

  if (needsData) {
    courseData = loadCourseData();
    let matchedCourses = [];

    if (opts.interactive) {
      matchedCourses = await interactiveSelect(courseData.courses);
    } else {
      if (opts.names.length > 0) {
        matchedCourses.push(...matchCoursesByName(courseData.courses, opts.names));
      }
      if (opts.ids.length > 0) {
        matchedCourses.push(...matchCoursesById(courseData.courses, opts.ids));
      }
      if (opts.indexes.length > 0) {
        matchedCourses.push(...matchCoursesByIndex(courseData.courses, opts.indexes));
      }
      if (opts.allUnfinished) {
        matchedCourses.push(...getUnfinishedCourses(courseData.courses));
      }
    }

    // 去重
    const seen = new Set();
    const unique = [];
    for (const c of matchedCourses) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        unique.push(c);
      }
    }

    if (unique.length === 0) {
      log('没有匹配到任何课程', 'warn');
      process.exit(0);
    }

    for (const course of unique) {
      urlsToOpen.push({
        url: CONFIG.COURSE_PLAY_URL_TEMPLATE + course.id,
        title: course.title,
      });
    }
  } else if (urlsToOpen.length === 0) {
    log('请指定要启动的课程（使用 --help 查看帮助）', 'warn');
    process.exit(0);
  }

  console.log('');
  log(`即将打开 ${urlsToOpen.length} 门课程:`, 'info');
  urlsToOpen.forEach((u, i) => {
    log(`  ${i + 1}. ${u.title} → ${u.url}`, 'info');
  });
  console.log('');

  // 启动浏览器
  log('正在启动浏览器...', 'info');
  const browser = await puppeteer.launch({
    headless: opts.headless || CONFIG.HEADLESS,
    defaultViewport: { width: 1440, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    // 打开第一个课程在当前标签页
    const firstPage = (await browser.pages())[0];
    await firstPage.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await openCourseWithEmbeddedPlayer(firstPage, urlsToOpen[0]);

    // 打开剩余课程在新标签页
    for (let i = 1; i < urlsToOpen.length; i++) {
      await new Promise(r => setTimeout(r, CONFIG.TAB_DELAY));
      const newPage = await browser.newPage();
      await newPage.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      );
      await openCourseWithEmbeddedPlayer(newPage, urlsToOpen[i]);
    }

    console.log('');
    log('══════════════════════════════════════════════════', 'success');
    log('  所有课程已打开，内置播放助手已自动接管播放', 'success');
    log('  浏览器保持打开状态，按 Ctrl+C 退出', 'success');
    log('══════════════════════════════════════════════════', 'success');
    console.log('');

    // 保持浏览器打开
    await new Promise(() => {});
  } catch (e) {
    log(`发生错误: ${e.message}`, 'error');
    console.error(e);
  }
}

main().catch(console.error);
