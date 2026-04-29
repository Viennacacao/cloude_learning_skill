#!/usr/bin/env node
/**
 * Agent 统一入口（自然对话 → 命令执行）
 *
 * 目标：
 * - 让“下载即用”的 Skill 在其他电脑上也能通过一条短命令被 Agent 调用
 * - 统一：学习/继续/全部/确认/取消/状态
 *
 * 典型用法：
 *   node scripts/agent-entry.js 学习 "阳明心学——实践的哲学" --headful
 *   node scripts/agent-entry.js 继续 --headless
 *   node scripts/agent-entry.js 全部 --headless
 *   node scripts/agent-entry.js 确认
 *   node scripts/agent-entry.js 取消
 *   node scripts/agent-entry.js 状态
 *
 * 说明：
 * - 课程学习由 21tb-login-crawler.js 完成
 * - 课后测试确认由 decision 文件驱动：本脚本负责写 decision 文件
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
// 自动加载项目根目录 .env（便于“下载即用”，避免用户手动 export 环境变量）
try {
  // eslint-disable-next-line import/no-extraneous-dependencies
  require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
} catch (e) {
  // ignore
}
const DEFAULT_LOGS_DIR = path.join(ROOT, 'runtime-logs');
const CRAWLER = path.join(__dirname, '21tb-login-crawler.js');

function printHelp() {
  console.log(`
云端视频学习 - Agent 统一入口

用法：
  node scripts/agent-entry.js <动作> [参数...]

动作：
  学习 <课程名>     学习并完成指定课程（完成后停下）
  继续             学习“第一门未完成课程”（完成后停下）
  全部             学完全部未完成课程（自动推进）
  确认             确认提交“最近一次”课后测试
  取消             取消提交“最近一次”课后测试
  状态             输出最近一次运行状态摘要

常用选项（仅对 学习/继续/全部 生效）：
  --headful                显示浏览器窗口
  --headless               后台运行（默认：Agent 模式是 headless，除非指定 --headful）
  --user-data-dir <dir>    自定义 Chrome profile 目录（复用登录态/缓存）
  --chrome-path <path>     指定系统 Chrome/Chromium 可执行文件
  --progress-logs <dir>    自定义日志目录（默认：runtime-logs）
  --no-auto-eval           关闭自动评估

环境变量（建议写入 .env）：
  TB_ENTERPRISE_ID / TB_USER / TB_PASS
  ZHIPU_API_KEY（可选）
  POSTTEST_REQUIRE_CONFIRM=true（推荐：自然对话确认）
`.trim());
  console.log('');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const action = (args.shift() || '').trim();

  const opts = {
    action,
    courseName: '',
    headful: false,
    headless: false,
    userDataDir: '',
    chromePath: '',
    logsDir: '',
    noAutoEval: false,
  };

  // 学习 <课程名>
  if (action === '学习') {
    opts.courseName = String(args.shift() || '').trim();
  }

  // 解析通用 flags
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--headful') opts.headful = true;
    else if (a === '--headless') opts.headless = true;
    else if (a === '--no-auto-eval') opts.noAutoEval = true;
    else if (a === '--user-data-dir' || a === '--profile-dir') opts.userDataDir = String(args[++i] || '');
    else if (a === '--chrome-path') opts.chromePath = String(args[++i] || '');
    else if (a === '--progress-logs') opts.logsDir = String(args[++i] || '');
  }

  return opts;
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function safeReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8') || '{}'); } catch { return null; }
}

function listFilesByMtime(dir, pattern) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => pattern.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        return { full, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files.map((x) => x.full);
  } catch {
    return [];
  }
}

function getLogsDir(opts) {
  const dir = opts.logsDir ? path.resolve(opts.logsDir) : DEFAULT_LOGS_DIR;
  ensureDir(dir);
  return dir;
}

function writeDecision({ logsDir, action, decisionPath }) {
  const act = String(action || '').toLowerCase();
  if (act !== 'confirm' && act !== 'cancel') {
    console.error('decision action 仅支持 confirm/cancel');
    process.exitCode = 2;
    return;
  }

  // 默认选择“最近一次请求文件”
  let reqPath = '';
  if (!decisionPath) {
    const reqs = listFilesByMtime(logsDir, /\.posttest_confirm_required\.json$/);
    reqPath = reqs[0] || '';
    if (!reqPath) {
      console.error('未找到 posttest_confirm_required.json（可能当前没有需要确认的课后测试）');
      process.exitCode = 2;
      return;
    }
    const req = safeReadJson(reqPath);
    decisionPath = req && req.decisionPath ? String(req.decisionPath) : '';
  }

  if (!decisionPath) {
    console.error('无法确定 decisionPath');
    process.exitCode = 2;
    return;
  }

  try {
    fs.writeFileSync(decisionPath, JSON.stringify({ action: act }, null, 2), 'utf-8');
    console.log(`已写入决策文件：${decisionPath}（action=${act}）`);
    if (reqPath) console.log(`来源请求文件：${reqPath}`);
  } catch (e) {
    console.error(`写入决策文件失败：${e.message}`);
    process.exitCode = 2;
  }
}

function printLatestState(logsDir) {
  const states = listFilesByMtime(logsDir, /\.state\.json$/);
  if (!states[0]) {
    console.log('暂无 state.json（请先运行一次学习命令）');
    return;
  }
  const st = safeReadJson(states[0]) || {};
  const phase = st.phase || 'unknown';
  const course = st.currentCourse || st.currentCourseTitle || '';
  const waiting = st.postTestConfirm && st.postTestConfirm.waiting;
  console.log(`最新状态文件：${states[0]}`);
  console.log(`阶段：${phase}`);
  if (course) console.log(`课程：${course}`);
  if (waiting) {
    console.log('课后测试：等待确认');
    if (st.postTestConfirm.decisionPath) console.log(`decisionPath：${st.postTestConfirm.decisionPath}`);
  }
}

function runCrawler(opts) {
  const logsDir = getLogsDir(opts);

  const args = [CRAWLER, '--agent', '--json'];
  if (opts.headful) args.push('--headful');
  if (opts.headless) args.push('--headless');
  if (opts.noAutoEval) args.push('--no-auto-eval');
  if (opts.userDataDir) args.push('--user-data-dir', opts.userDataDir);
  if (opts.chromePath) args.push('--chrome-path', opts.chromePath);
  if (logsDir) args.push('--progress-logs', logsDir);

  if (opts.action === '学习') {
    if (!opts.courseName) {
      console.error('用法：学习 <课程名>');
      process.exitCode = 2;
      return;
    }
    args.push('-c', opts.courseName);
  } else if (opts.action === '继续') {
    args.push('--auto'); // 自动进入第一门未完成课程
  } else if (opts.action === '全部') {
    args.push('--auto', '--auto-advance');
  } else {
    console.error(`未知动作：${opts.action}`);
    printHelp();
    process.exitCode = 2;
    return;
  }

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (buf) => process.stdout.write(buf));
  child.stderr.on('data', (buf) => process.stderr.write(buf));

  child.on('close', (code) => {
    process.exitCode = code ?? 0;
  });
}

function main() {
  const opts = parseArgs(process.argv);
  if (!opts.action || opts.action === '--help' || opts.action === '-h' || opts.action === 'help') {
    printHelp();
    return;
  }

  const logsDir = getLogsDir(opts);

  if (opts.action === '确认') {
    writeDecision({ logsDir, action: 'confirm' });
    return;
  }
  if (opts.action === '取消') {
    writeDecision({ logsDir, action: 'cancel' });
    return;
  }
  if (opts.action === '状态') {
    printLatestState(logsDir);
    return;
  }

  runCrawler(opts);
}

main();
