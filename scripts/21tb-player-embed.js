const fs = require('fs');
const path = require('path');

const HELPER_FILE = path.join(__dirname, '..', '21tb-video-helper.user.js');
const EVAL_AUTO_FILE = path.join(__dirname, '21tb-evaluation-auto.js');

function loadEmbeddedHelperSource() {
  const raw = fs.readFileSync(HELPER_FILE, 'utf-8');
  return raw.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/m, '').trim();
}

function loadEvalAutoSource() {
  return fs.readFileSync(EVAL_AUTO_FILE, 'utf-8');
}

function normalizeConfig(config = {}) {
  return {
    autoStart: config.autoStart !== false,
    autoStartDelayMs: Number(config.autoStartDelayMs) || 1800,
    defaultSpeed: Number(config.defaultSpeed) || 16,
    source: config.source || 'skill-embedded',
    // 评估自动完成配置
    autoEval: config.autoEval !== false,          // 是否自动完成评估（默认开启）
    evalStars: Number(config.evalStars) || 5,     // 星级评分
    evalChoice: (config.evalChoice || 'd').toLowerCase(), // 选择题选项
    evalEssay: config.evalEssay || '很不错，高效',        // 论述题答案
  };
}

async function prepareEmbeddedPlayer(page, config = {}) {
  const helperSource = loadEmbeddedHelperSource();
  const evalAutoSource = loadEvalAutoSource();
  const embedConfig = normalizeConfig(config);

  await page.evaluateOnNewDocument(
    ({ helperSource, evalAutoSource, embedConfig }) => {
      window.__TBH_EMBED_CONFIG__ = embedConfig;

      const injectHelperScript = () => {
        if (window.__TBH_EMBED_SCRIPT_INJECTED__) return;
        window.__TBH_EMBED_SCRIPT_INJECTED__ = true;

        const script = document.createElement('script');
        script.type = 'text/javascript';
        script.setAttribute('data-tbh-embedded', '1');
        script.textContent = helperSource;
        (document.documentElement || document.head || document.body).appendChild(script);
        script.remove();

        // 同时注入评估自动完成模块
        if (embedConfig.autoEval) {
          const evalScript = document.createElement('script');
          evalScript.type = 'text/javascript';
          evalScript.setAttribute('data-tbh-eval-auto', '1');
          evalScript.textContent = evalAutoSource;
          (document.documentElement || document.head || document.body).appendChild(evalScript);
          evalScript.remove();
        }
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectHelperScript, { once: true });
      } else {
        injectHelperScript();
      }
    },
    { helperSource, evalAutoSource, embedConfig }
  );

  return embedConfig;
}

async function waitForEmbeddedPlayer(page, timeout = 20000) {
  await page.waitForFunction(() => {
    return !!(window.__TBH_HELPER__ && typeof window.__TBH_HELPER__.getState === 'function');
  }, { timeout });

  return page.evaluate(() => window.__TBH_HELPER__.getState());
}

async function getEmbeddedPlayerState(page) {
  try {
    const ready = await page.evaluate(() => {
      return !!(window.__TBH_HELPER__ && typeof window.__TBH_HELPER__.getState === 'function');
    });
    if (!ready) return null;
    return page.evaluate(() => window.__TBH_HELPER__.getState());
  } catch {
    return null;
  }
}

module.exports = {
  prepareEmbeddedPlayer,
  waitForEmbeddedPlayer,
  getEmbeddedPlayerState,
};

// ============================================================
// Course Evaluation 自动完成 — 集成接口
// ============================================================

/**
 * 检测当前页面或任意 iframe 是否为评估页面
 */
async function isEvaluationPage(page) {
  for (const frame of page.frames()) {
    try {
      const onEvalPage = await frame.evaluate(() => !!document.querySelector('.course-evaluate'));
      if (onEvalPage) return true;
    } catch (e) {
      // 忽略跨域 frame 报错
    }
  }
  return false;
}

/**
 * 等待评估页面出现（轮询检测）
 * @param {import('puppeteer').Page} page
 * @param {number} timeout - 超时毫秒数
 * @returns {Promise<boolean>}
 */
async function waitForEvaluationPage(page, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await isEvaluationPage(page)) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/**
 * 触发自动评估填写并提交
 * @param {import('puppeteer').Page} page
 * @param {Object} options - 可覆盖默认配置
 * @returns {Promise<{success: boolean, steps: Object, error?: string}>}
 */
async function runEvaluationAuto(page, options = {}) {
  // 查找包含评估内容的 frame
  let targetFrame = null;
  for (const frame of page.frames()) {
    try {
      const onEvalPage = await frame.evaluate(() => !!document.querySelector('.course-evaluate'));
      if (onEvalPage) {
        targetFrame = frame;
        break;
      }
    } catch (e) {}
  }

  if (!targetFrame) {
    return { success: false, error: 'Evaluation container (.course-evaluate) not found in any frame' };
  }

  // 确保 eval-auto 模块已在该 frame 注入
  const injected = await targetFrame.evaluate(() => !!window.__TBH_EVAL_AUTO__);
  
  if (!injected) {
    const source = loadEvalAutoSource();
    await targetFrame.evaluate((src) => {
      const s = document.createElement('script');
      s.textContent = src;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    }, source);
  }

  // 执行填写提交
  return targetFrame.evaluate((opts) => {
    if (!window.__TBH_EVAL_AUTO__) {
      return { success: false, error: 'EvalAuto module not available in target frame' };
    }
    return window.__TBH_EVAL_AUTO__.fillAndSubmit(opts);
  }, options);
}

/**
 * 监听课程学习流程，在视频播放完毕进入评估页时自动触发评估
 * 
 * 使用方式：在 course-launcher 或 crawler 的主循环中调用：
 *   await pollAndHandleEvaluation(page);  // 返回 true 表示评估已完成
 * 
 * @param {import('puppeteer').Page} page
 * @param {Object} [config]
 * @param {number} [config.pollInterval=2000] - 轮询间隔(ms)
 * @param {number} [config.maxWait=120000] - 最大等待时间(ms)
 * @param {boolean} [config.autoRun=true] - 检测到评估页后是否立即自动执行
 * @returns {Promise<{detected: boolean, completed: boolean, result?: Object}>}
 */
async function pollAndHandleEvaluation(page, config = {}) {
  const {
    pollInterval = 2000,
    maxWait = 120000,
    autoRun = true,
  } = config;

  const start = Date.now();

  while (Date.now() - start < maxWait) {
    // 检查是否出现评估页面
    const onEvalPage = await isEvaluationPage(page);
    
    if (onEvalPage) {
      console.log('[TBH-Eval] 📋 Evaluation page detected!');
      
      if (autoRun) {
        console.log('[TBH-Eval] Auto-filling evaluation...');
        const result = await runEvaluationAuto(page);
        console.log(`[TBH-Eval] ${result.success ? '✅ Evaluation completed!' : '❌ Evaluation failed: ' + (result.error || 'unknown')}`);
        return { detected: true, completed: result.success, result };
      }

      return { detected: true, completed: false };
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  return { detected: false, completed: false };
}

module.exports.isEvaluationPage = isEvaluationPage;
module.exports.waitForEvaluationPage = waitForEvaluationPage;
module.exports.runEvaluationAuto = runEvaluationAuto;
module.exports.pollAndHandleEvaluation = pollAndHandleEvaluation;
