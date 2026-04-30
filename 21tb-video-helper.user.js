// ==UserScript==
// @name         时光易学视频助手2.0
// @namespace    https://greasyfork.org/users/cacao
// @version      2.3.0
// @description  自动播放课程视频、切换章节、设置倍速、自动完成课程评估，并支持 Skill 内嵌自动启动与状态回写
// @author       cacao
// @match        *://*/*courseLearning/play*
// @match        *://*/*courseSetting/*play*
// @grant        none
// @license      MIT
// ==/UserScript==


(function () {
  'use strict';

  // ========================
  // 内部日志（用于调试/验收）
  // ========================
  const LOG_BUFFER_MAX = 200;
  const logBuffer = [];
  let lastAction = '';
  let lastActionAt = '';
  let lastActionDetail = null;

  // ========================
  // 配置项
  // ========================
  const CONFIG = {
    DEFAULT_SPEED: 16,        // 默认播放倍速
    MAX_SPEED: 16,           // 最高播放倍速
    MIN_SPEED: 1,            // 最低播放倍速
    SPEED_STEP: 2,         // 倍速调节步长
    NEXT_WAIT_MS: 2000,      // 点击下一节后的等待时间
    CHECK_INTERVAL_MS: 1000, // 轮询检测间隔
    MAX_RETRIES: 90,         // 最大重试次数
    NEXT_BTN_DELAY_MS: 8000, // 「下一步」按钮出现后等待多久再点击
    ADVANCE_DELAY_AFTER_ENDED_MS: 6000, // 视频播完后，延迟多久再点"下一节"（用于触发 completed）
    STUCK_MAX: 5,            // 同一片段连续检测未推进多少次视为卡死
    POSTTEST_CONFIRM_TIMEOUT_MS: 15 * 60 * 1000, // 课后测试确认提交超时
    POSTTEST_BANK_KEY: 'TBH_POSTTEST_BANK_V1',
  };

  // ========================
  // 全局状态
  // ========================
  let isRunning = false;
  let currentSpeed = CONFIG.DEFAULT_SPEED;
  let uiInjected = false;
  let autoStartTriggered = false;
  let lastUrl = window.location.href;
  let checkTimer = null;
  let postTestConfirmState = {
    waiting: false,
    resolver: null,
    planSummary: null,
  };
  let postTestProgress = {
    active: false,
    stage: 'idle',
    summary: '待命',
    total: 0,
    resolved: 0,
    fromBank: 0,
    fromAI: 0,
    fromRule: 0,
    avgConfidence: 0,
  };

  // ========================
  // 进度与状态追踪（供 Node 端读取）
  // ========================
  let playProgress = {
    totalResources: 0,
    finishedResources: 0,
    currentResourceName: '',
    currentChapterIdx: -1,
    currentSectionIdx: -1,
    courseCompleted: false,
    // 严格模式：是否曾经成功解析到资源列表（>0）
    hasSeenResources: false,
    startedAt: null,
    lastActivityAt: null,
  };

  // 防循环：卡死检测（连续多次停留在同一资源）
  let lastResourceKey = '';
  let stuckCount = 0;

  function getEmbedConfig() {
    return window.__TBH_EMBED_CONFIG__ || {};
  }

  // ========================
  // 跨窗口可视化与回传（用于 Trae “独立播放窗口”无法打开 DevTools 的场景）
  // ========================
  const CHANNEL_NAME = 'TBH_CHANNEL_V1';
  let bc = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel(CHANNEL_NAME);
    }
  } catch (_) {
    bc = null;
  }

  function handleCmdMessage(payload) {
    try {
      if (!payload || payload.type !== 'TBH_CMD') return;
      const action = String(payload.action || '').toLowerCase();
      if (action === 'confirm_posttest') confirmPostTestSubmit('confirm');
      if (action === 'cancel_posttest') confirmPostTestSubmit('cancel');
      if (action === 'start') startAutoPlay();
      if (action === 'stop') stopAutoPlay('cmd');
      broadcastState('cmd:' + action);
    } catch (_) {}
  }

  function safePostMessage(payload) {
    // 1) BroadcastChannel（同源多窗口最稳）
    try {
      if (bc) bc.postMessage(payload);
    } catch (_) {}
    // 2) opener.postMessage（如果是 window.open 打开的，且仍可访问）
    try {
      if (window.opener && typeof window.opener.postMessage === 'function') {
        window.opener.postMessage(payload, '*');
      }
    } catch (_) {}
  }

  function ensureInjectedBadge() {
    try {
      if (document.getElementById('tbhInjectedBadge')) return;
      const badge = document.createElement('div');
      badge.id = 'tbhInjectedBadge';
      badge.style.cssText = [
        'position:fixed',
        'top:10px',
        'left:10px',
        'z-index:2147483647',
        'background:rgba(0,0,0,0.78)',
        'color:#fff',
        'font-size:12px',
        'line-height:1',
        'padding:8px 10px',
        'border-radius:8px',
        'box-shadow:0 6px 18px rgba(0,0,0,.25)',
        'user-select:text',
        'cursor:default',
        'max-width:70vw',
        'white-space:pre-line',
      ].join(';');
      badge.textContent = 'TBH 已注入\n状态：待初始化';
      (document.body || document.documentElement).appendChild(badge);
    } catch (_) {}
  }

  function updateInjectedBadge(textLines) {
    try {
      const el = document.getElementById('tbhInjectedBadge');
      if (!el) return;
      el.textContent = textLines;
    } catch (_) {}
  }

  function syncHelperApi() {
    window.__TBH_HELPER__ = {
      version: '2.3.7',
      start: startAutoPlay,
      stop: (reason) => stopAutoPlay(reason || 'api'),
      approvePostTestSubmit: () => confirmPostTestSubmit('confirm'),
      rejectPostTestSubmit: () => confirmPostTestSubmit('cancel'),
      _debug: () => buildDebugSnapshot(),
      getState: () => ({
        isRunning,
        currentSpeed,
        uiInjected,
        autoStartTriggered,
        mode: getEmbedConfig().source || 'userscript',
        autoStart: !!getEmbedConfig().autoStart,
        url: window.location.href,
        progress: { ...playProgress },
        logs: logBuffer.slice(-LOG_BUFFER_MAX),
        postTestConfirm: {
          waiting: postTestConfirmState.waiting,
          summary: postTestConfirmState.planSummary,
        },
        postTestProgress: { ...postTestProgress },
        debug: {
          lastAction,
          lastActionAt,
          lastActionDetail,
        },
      }),
    };
  }

  function buildDebugSnapshot() {
    const nextBtn = document.querySelector('.info-next-text') || document.querySelector('.next-button') || null;
    const replayBtn = document.querySelector('.replay-btn') || null;
    const video = document.querySelector('video') || null;
    const container =
      document.querySelector('.chapter-container') ||
      document.querySelector('.learning-container') ||
      document.querySelector('.section-list') ||
      document.querySelector('.catalogue-wrap') ||
      null;
    const comp = container ? getVueComponent(container) : null;
    const courseData = comp && comp.$data ? comp.$data.courseData : null;
    const curIndex = comp && comp.$data ? comp.$data.curIndex : null;
    return {
      url: location.href,
      selectors: {
        containerFound: !!container,
        nextBtnFound: !!nextBtn,
        replayBtnFound: !!replayBtn,
        videoFound: !!video,
      },
      nextBtn: nextBtn ? { class: nextBtn.className, text: (nextBtn.textContent || '').trim(), disabled: !!nextBtn.disabled } : null,
      replayBtn: replayBtn ? { class: replayBtn.className, text: (replayBtn.textContent || '').trim() } : null,
      video: video ? { paused: video.paused, ended: video.ended, currentTime: video.currentTime, duration: video.duration, playbackRate: video.playbackRate } : null,
      vue: {
        hasComp: !!comp,
        curIndex,
        hasCourseData: !!courseData,
        courseChapters: Array.isArray(courseData) ? courseData.length : 0,
      },
      progress: { ...playProgress },
      lastAction,
      lastActionAt,
      lastActionDetail,
    };
  }

  function broadcastState(reason) {
    try {
      if (!window.__TBH_HELPER__ || !window.__TBH_HELPER__.getState) return;
      const st = window.__TBH_HELPER__.getState();
      safePostMessage({
        type: 'TBH_STATE',
        reason: reason || 'tick',
        at: new Date().toISOString(),
        url: location.href,
        state: st,
      });
      // 同时更新徽标，便于肉眼确认“已注入且在跑”
      const p = st.progress || {};
      const lines = [
        'TBH 已注入',
        `状态：${st.isRunning ? '运行中' : '待命'}`,
        `进度：${Number(p.finishedResources || 0)}/${Number(p.totalResources || 0)}`,
        p.currentResourceName ? `当前：${p.currentResourceName}` : '',
        st.postTestConfirm && st.postTestConfirm.waiting ? '课后测试：等待确认' : '',
      ].filter(Boolean).join('\n');
      updateInjectedBadge(lines);
    } catch (_) {}
  }

  function applyEmbeddedDefaults() {
    const cfg = getEmbedConfig();
    const nextSpeed = Number(cfg.defaultSpeed);
    if (Number.isFinite(nextSpeed) && nextSpeed > 0) {
      currentSpeed = Math.max(CONFIG.MIN_SPEED, Math.min(CONFIG.MAX_SPEED, nextSpeed));
    }
    const speedVal = document.getElementById('tbhSpeedVal');
    if (speedVal) {
      speedVal.textContent = `${currentSpeed}x`;
    }
    syncHelperApi();
    broadcastState('applyEmbeddedDefaults');
  }

  function startBroadcastLoop() {
    // 每 2 秒回传一次状态（足够实时，又不会过度消耗）
    try {
      if (window.__TBH_BROADCAST_TIMER__) return;
      window.__TBH_BROADCAST_TIMER__ = setInterval(() => {
        broadcastState('loop');
      }, 2000);
    } catch (_) {}
  }

  function maybeAutoStart() {
    const cfg = getEmbedConfig();
    if (!cfg.autoStart || autoStartTriggered || isRunning || !uiInjected) return;
    autoStartTriggered = true;
    syncHelperApi();
    broadcastState('autoStartTriggered');
    const delay = Number(cfg.autoStartDelayMs) > 0 ? Number(cfg.autoStartDelayMs) : 1800;
    addLog(`检测到 Skill 内嵌模式，${Math.round(delay / 100) / 10}s 后自动启动`, 'info');
    window.setTimeout(() => {
      if (!document.getElementById('tbhStartBtn') || isRunning) return;
      addLog('🤖 由 Skill 内置播放助手自动启动', 'success');
      startAutoPlay();
    }, delay);
  }

  // 立刻注入一个“已注入徽标”（即使课程页面资源尚未完全渲染，也能让用户看到脚本确实进来了）
  ensureInjectedBadge();
  // 尽早暴露 API 并开始回传
  syncHelperApi();
  applyEmbeddedDefaults();
  startBroadcastLoop();

  // 监听来自父窗口/同源窗口的控制命令（解决“独立播放窗口无法打开 DevTools、但需要远程确认/取消 post-test”的场景）
  try {
    if (bc) bc.onmessage = (ev) => handleCmdMessage(ev && ev.data);
  } catch (_) {}
  try {
    window.addEventListener('message', (ev) => handleCmdMessage(ev && ev.data));
  } catch (_) {}

  // ========================
  // UI 注入：控制面板 + 样式 + 拖拽
  // ========================
  function injectUI() {
    const style = document.createElement('style');
    style.setAttribute('data-tbh-style', '1');
    style.textContent = `
      .tbh-panel {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 999999;
        width: 340px;
        background: rgba(22, 22, 28, 0.95);
        backdrop-filter: blur(12px);
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #e0e0e0;
        overflow: hidden;
        transition: all 0.3s ease;
      }
      .tbh-panel.minimized .tbh-body { display: none; }
      .tbh-panel.minimized { width: auto; }
      .tbh-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        background: rgba(255,255,255,0.05);
        cursor: move;
        user-select: none;
      }
      .tbh-title {
        font-size: 13px;
        font-weight: 600;
        color: #fff;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .tbh-title .dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        background: #555;
        transition: background 0.3s;
      }
      .tbh-title .dot.active { background: #52c41a; animation: tbh-pulse 2s infinite; }
      .tbh-title .dot.stopped { background: #ff4d4f; }
      @keyframes tbh-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
      .tbh-header-btns { display: flex; gap: 4px; }
      .tbh-header-btns button {
        width: 24px; height: 24px;
        border: none; border-radius: 4px;
        background: rgba(255,255,255,0.1);
        color: #999; cursor: pointer;
        font-size: 12px;
        display: flex; align-items: center; justify-content: center;
        transition: all 0.2s;
      }
      .tbh-header-btns button:hover { background: rgba(255,255,255,0.2); color: #fff; }
      .tbh-controls {
        padding: 12px 16px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .tbh-speed-row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 10px;
      }
      .tbh-speed-label {
        font-size: 12px;
        color: #999;
        white-space: nowrap;
      }
      .tbh-speed-value {
        font-size: 18px;
        font-weight: 700;
        color: #1677ff;
        min-width: 50px;
        text-align: center;
      }
      .tbh-speed-btns {
        display: flex;
        gap: 4px;
      }
      .tbh-speed-btns button {
        width: 28px; height: 28px;
        border: none; border-radius: 6px;
        background: rgba(22, 119, 255, 0.15);
        color: #1677ff; cursor: pointer;
        font-size: 16px; font-weight: 700;
        display: flex; align-items: center; justify-content: center;
        transition: all 0.2s;
      }
      .tbh-speed-btns button:hover { background: rgba(22, 119, 255, 0.3); }
      .tbh-speed-btns button:disabled { opacity: 0.3; cursor: not-allowed; }
      .tbh-start-btn {
        width: 100%;
        padding: 8px 0;
        border: none; border-radius: 8px;
        font-size: 14px; font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
      }
      .tbh-start-btn.start {
        background: linear-gradient(135deg, #1677ff, #4096ff);
        color: #fff;
      }
      .tbh-start-btn.start:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(22,119,255,0.4); }
      .tbh-start-btn.stop {
        background: linear-gradient(135deg, #ff4d4f, #ff7875);
        color: #fff;
      }
      .tbh-start-btn.stop:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(255,77,79,0.4); }
      .tbh-confirm-row {
        display: none;
        gap: 8px;
        margin-top: 10px;
      }
      .tbh-confirm-row.show {
        display: flex;
      }
      .tbh-posttest-progress {
        margin-top: 8px;
        padding: 8px 10px;
        border-radius: 8px;
        background: rgba(22, 119, 255, 0.12);
        border: 1px solid rgba(22, 119, 255, 0.25);
        font-size: 12px;
        line-height: 1.5;
        color: #9dc3ff;
      }
      .tbh-posttest-progress.active {
        background: rgba(250, 173, 20, 0.12);
        border-color: rgba(250, 173, 20, 0.35);
        color: #ffd591;
      }
      .tbh-posttest-progress.done {
        background: rgba(82, 196, 26, 0.12);
        border-color: rgba(82, 196, 26, 0.35);
        color: #b7eb8f;
      }
      .tbh-posttest-progress.error {
        background: rgba(255, 77, 79, 0.12);
        border-color: rgba(255, 77, 79, 0.35);
        color: #ffccc7;
      }
      .tbh-confirm-btn {
        flex: 1;
        padding: 8px 0;
        border: none;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .tbh-confirm-btn.ok {
        background: linear-gradient(135deg, #13c2c2, #36cfc9);
        color: #fff;
      }
      .tbh-confirm-btn.cancel {
        background: rgba(255,255,255,0.12);
        color: #ddd;
      }
      .tbh-body {
        max-height: 260px;
        overflow-y: auto;
        padding: 8px 0;
      }
      .tbh-body::-webkit-scrollbar { width: 4px; }
      .tbh-body::-webkit-scrollbar-track { background: transparent; }
      .tbh-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }
      .tbh-log {
        padding: 4px 16px;
        font-size: 12px;
        line-height: 1.6;
        font-family: "SF Mono", "Menlo", "Consolas", monospace;
      }
      .tbh-log.info { color: #999; }
      .tbh-log.success { color: #52c41a; }
      .tbh-log.warn { color: #faad14; }
      .tbh-log.error { color: #ff4d4f; }
      .tbh-log .time { color: #555; margin-right: 6px; }
      .tbh-panel.dragging { opacity: 0.85; }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.className = 'tbh-panel';
    panel.innerHTML = `
      <div class="tbh-header">
        <div class="tbh-title">
          <span class="dot" id="tbhDot"></span>
          时光易学助手
        </div>
        <div class="tbh-header-btns">
          <button id="tbhMinBtn" title="最小化">—</button>
        </div>
      </div>
      <div class="tbh-controls">
        <div class="tbh-speed-row">
          <span class="tbh-speed-label">播放倍速</span>
          <div class="tbh-speed-btns">
            <button id="tbhSpeedDown" title="减速">−</button>
          </div>
          <span class="tbh-speed-value" id="tbhSpeedVal">${currentSpeed}x</span>
          <div class="tbh-speed-btns">
            <button id="tbhSpeedUp" title="加速">+</button>
          </div>
        </div>
        <button class="tbh-start-btn start" id="tbhStartBtn">启动自动播放</button>
        <div class="tbh-confirm-row" id="tbhConfirmRow">
          <button class="tbh-confirm-btn ok" id="tbhConfirmSubmitBtn">确认提交测试</button>
          <button class="tbh-confirm-btn cancel" id="tbhCancelSubmitBtn">继续检查</button>
        </div>
        <div class="tbh-posttest-progress" id="tbhPostTestProgress">课后测试进度：待命</div>
      </div>
      <div class="tbh-body" id="tbhLogArea"></div>
    `;
    document.body.appendChild(panel);

    bindUIEvents();
    renderPostTestProgress();
  }

  function bindUIEvents() {
    const startBtn = document.getElementById('tbhStartBtn');
    const speedDownBtn = document.getElementById('tbhSpeedDown');
    const speedUpBtn = document.getElementById('tbhSpeedUp');
    const minBtn = document.getElementById('tbhMinBtn');
    const confirmSubmitBtn = document.getElementById('tbhConfirmSubmitBtn');
    const cancelSubmitBtn = document.getElementById('tbhCancelSubmitBtn');

    if (startBtn) {
      startBtn.addEventListener('click', () => {
        isRunning ? stopAutoPlay('ui_button') : startAutoPlay();
      });
    }
    speedDownBtn.addEventListener('click', () => {
      if (currentSpeed > CONFIG.MIN_SPEED) {
        currentSpeed = Math.round((currentSpeed - CONFIG.SPEED_STEP) * 10) / 10;
        document.getElementById('tbhSpeedVal').textContent = `${currentSpeed}x`;
        applySpeed();
        syncHelperApi();
        addLog(`倍速调整为 ${currentSpeed}x`, 'info');
      }
    });
    speedUpBtn.addEventListener('click', () => {
      if (currentSpeed < CONFIG.MAX_SPEED) {
        currentSpeed = Math.round((currentSpeed + CONFIG.SPEED_STEP) * 10) / 10;
        document.getElementById('tbhSpeedVal').textContent = `${currentSpeed}x`;
        applySpeed();
        syncHelperApi();
        addLog(`倍速调整为 ${currentSpeed}x`, 'info');
      }
    });
    minBtn.addEventListener('click', () => {
      const panel = document.querySelector('.tbh-panel');
      panel.classList.toggle('minimized');
      minBtn.textContent = panel.classList.contains('minimized') ? '□' : '—';
    });
    if (confirmSubmitBtn) confirmSubmitBtn.addEventListener('click', () => confirmPostTestSubmit('confirm'));
    if (cancelSubmitBtn) cancelSubmitBtn.addEventListener('click', () => confirmPostTestSubmit('cancel'));
    makeDraggable(document.querySelector('.tbh-panel'), document.querySelector('.tbh-header'));
  }

  function makeDraggable(el, handle) {
    let offsetX = 0, offsetY = 0, isDragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      isDragging = true;
      el.classList.add('dragging');
      const rect = el.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      let x = e.clientX - offsetX;
      let y = e.clientY - offsetY;
      x = Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth));
      y = Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight));
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      isDragging = false;
      el.classList.remove('dragging');
    });
  }

  function addLog(msg, level = 'info') {
    try {
      const now = new Date();
      logBuffer.push({
        at: now.toISOString(),
        level,
        msg: String(msg),
      });
      while (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
    } catch (_) {}

    const logArea = document.getElementById('tbhLogArea');
    if (!logArea) return;
    const now = new Date();
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map(n => String(n).padStart(2, '0')).join(':');
    const div = document.createElement('div');
    div.className = `tbh-log ${level}`;
    div.innerHTML = `<span class="time">[${time}]</span>${escapeHtml(msg)}`;
    logArea.appendChild(div);
    while (logArea.children.length > 100) {
      logArea.removeChild(logArea.firstChild);
    }
    logArea.scrollTop = logArea.scrollHeight;
  }

  function renderPostTestProgress() {
    const el = document.getElementById('tbhPostTestProgress');
    if (!el) return;
    const parts = [];
    const stageMap = {
      idle: '待命',
      detecting: '页面识别',
      extracting: '提取题目',
      planning: '生成答案方案',
      applying: '填答中',
      confirming: '等待确认',
      submitting: '提交中',
      done: '已完成',
      error: '异常',
    };
    const stageText = stageMap[postTestProgress.stage] || postTestProgress.stage || '待命';
    parts.push(`课后测试进度：${stageText}`);
    if (postTestProgress.total > 0) {
      parts.push(`${postTestProgress.resolved}/${postTestProgress.total} 题`);
    }
    if (postTestProgress.total > 0 && postTestProgress.stage !== 'idle') {
      parts.push(`题库:${postTestProgress.fromBank} AI:${postTestProgress.fromAI} 规则:${postTestProgress.fromRule}`);
    }
    if (postTestProgress.avgConfidence > 0) {
      parts.push(`置信度:${(postTestProgress.avgConfidence * 100).toFixed(1)}%`);
    }
    if (postTestProgress.summary) {
      parts.push(postTestProgress.summary);
    }
    el.textContent = parts.join(' | ');
    el.classList.remove('active', 'done', 'error');
    if (postTestProgress.stage === 'done') el.classList.add('done');
    else if (postTestProgress.stage === 'error') el.classList.add('error');
    else if (postTestProgress.active) el.classList.add('active');
  }

  function updatePostTestProgress(patch = {}) {
    postTestProgress = {
      ...postTestProgress,
      ...patch,
    };
    renderPostTestProgress();
    syncHelperApi();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function updateUI(running) {
    const dot = document.getElementById('tbhDot');
    const btn = document.getElementById('tbhStartBtn');
    if (running) {
      dot.className = 'dot active';
      btn.className = 'tbh-start-btn stop';
      btn.textContent = '停止自动播放';
    } else {
      dot.className = 'dot stopped';
      btn.className = 'tbh-start-btn start';
      btn.textContent = '启动自动播放';
    }
    syncHelperApi();
  }

  function getVueComponent(el) {
    let node = el;
    while (node) {
      // Vue2
      if (node.__vue__) return node.__vue__;
      // Vue3
      if (node.__vueParentComponent && node.__vueParentComponent.proxy) return node.__vueParentComponent.proxy;
      node = node.parentElement;
    }
    return null;
  }

  function waitForCondition(checkFn, interval = CONFIG.CHECK_INTERVAL_MS, maxRetries = CONFIG.MAX_RETRIES) {
    return new Promise((resolve, reject) => {
      let count = 0;
      const timer = setInterval(() => {
        count++;
        if (checkFn()) { clearInterval(timer); resolve(); }
        else if (count >= maxRetries) { clearInterval(timer); reject(new Error(`等待超时 (${count}次)`)); }
      }, interval);
    });
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function findNextButtonEl() {
    const btn = document.querySelector('.info-next-text') || document.querySelector('.next-button');
    if (!btn) return null;
    if (btn.offsetHeight <= 0) return null;
    if (btn.disabled) return null;
    return btn;
  }

  async function waitForNextButtonEl(timeoutMs = 15000) {
    const start = Date.now();
    while (isRunning && Date.now() - start < timeoutMs) {
      const btn = findNextButtonEl();
      if (btn) return btn;
      await sleep(250);
    }
    return null;
  }

  async function handleAdvanceByNextButton(reason = 'unknown') {
    // 统一处理：检测到 next 按钮 → 等 3 秒 → 点击 → 等待推进/消失
    lastAction = 'advance_by_next_button';
    lastActionAt = new Date().toISOString();
    lastActionDetail = { reason, delayMs: CONFIG.ADVANCE_DELAY_AFTER_ENDED_MS };

    addLog(`✅ 检测到 Next 按钮（${reason}），等待 ${CONFIG.ADVANCE_DELAY_AFTER_ENDED_MS / 1000}s 后点击以触发完成标记...`, 'info');
    await sleep(CONFIG.ADVANCE_DELAY_AFTER_ENDED_MS);

    // 3 秒内平台可能自动推进：若 next 已消失则直接返回
    if (!findNextButtonEl()) {
      addLog('✅ Next 按钮已消失，推测平台已自动推进，跳过点击', 'success');
      return true;
    }

    const btn = await waitForNextButtonEl(3000);
    if (!btn) {
      addLog('⚠️ 未找到可点击的 Next 按钮（可能被隐藏/禁用），跳过本次点击', 'warn');
      return false;
    }

    btn.click();
    addLog('👉 已点击 Next 按钮', 'success');

    // 等待按钮消失或视频重新开始（最多 20 秒）
    const start = Date.now();
    while (isRunning && Date.now() - start < 20000) {
      await sleep(300);
      if (!findNextButtonEl()) return true;
      const v = document.querySelector('video');
      if (v && v.currentTime < 1 && !v.ended) return true;
    }
    addLog('⚠️ 点击 Next 后未观察到推进迹象（按钮仍存在），稍后由主循环兜底处理', 'warn');
    return false;
  }

  function applySpeed() {
    const video = document.querySelector('video');
    if (video) { video.playbackRate = currentSpeed; }
    try {
      if (window.player && window.player.$data && window.player.$data.player) {
        const aliPlayer = window.player.$data.player;
        if (typeof aliPlayer.setSpeed === 'function') { aliPlayer.setSpeed(currentSpeed); }
        else if (typeof aliPlayer.setPlayerOptions === 'function') { aliPlayer.setPlayerOptions({ playbackRate: currentSpeed }); }
      }
    } catch (e) { }
  }

  // 在播放器晚加载/异步挂载时，持续尝试设置倍速并触发播放
  let speedEnforcerTimer = null;
  let lastPlayAttemptAt = 0;
  function startSpeedEnforcer() {
    if (speedEnforcerTimer) return;
    speedEnforcerTimer = setInterval(() => {
      try {
        applySpeed();
        const video = document.querySelector('video');
        // 重要：不要每秒都调用 play()，否则 AliPlayer 会疯狂刷屏 "do play successfully"
        // 仅在 paused 且未 ended 时，做节流尝试（默认 5 秒一次）。
        if (video && video.paused && !video.ended) {
          const now = Date.now();
          if (now - lastPlayAttemptAt >= 5000) {
            lastPlayAttemptAt = now;
            const p = video.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          }
        }
      } catch (e) {}
    }, 1000);
  }
  function stopSpeedEnforcer() {
    try { if (speedEnforcerTimer) clearInterval(speedEnforcerTimer); } catch {}
    speedEnforcerTimer = null;
    lastPlayAttemptAt = 0;
  }

  async function waitForResourcesReady(maxWaitMs = 120000) {
    const startAt = Date.now();
    while (isRunning && (Date.now() - startAt) < maxWaitMs) {
      const comp = getCoursePlayComponent();
      const data = getCourseData(comp);
      if (!comp || !data) {
        addLog('课程组件/数据未就绪，等待加载...', 'warn');
        await sleep(2000);
        continue;
      }
      const resources = getAllResources(data);
      if (resources.length > 0) return { comp, data, resources };
      addLog('课程资源列表为空（0/0），等待课程目录加载...', 'warn');
      // 关键：严格模式下 0/0 永不判定完成
      playProgress.courseCompleted = false;
      playProgress.totalResources = 0;
      playProgress.finishedResources = 0;
      playProgress.hasSeenResources = false;
      syncHelperApi();
      await sleep(2000);
    }
    return null;
  }

  function getCoursePlayComponent() {
    const el =
      document.querySelector('.chapter-container') ||
      document.querySelector('.learning-container') ||
      document.querySelector('.section-list') ||
      document.querySelector('.catalogue-wrap');
    return el ? getVueComponent(el) : null;
  }

  function getCourseData(comp) {
    if (!comp || !comp.$data || !comp.$data.courseData) return null;
    return comp.$data.courseData;
  }

  function getAllResources(courseData) {
    const list = [];
    if (!courseData || !Array.isArray(courseData)) return list;
    courseData.forEach((chapter, chIdx) => {
      if (chapter.resourceDTOS && Array.isArray(chapter.resourceDTOS)) {
        chapter.resourceDTOS.forEach((res, secIdx) => {
          list.push({
            chapterIdx: chIdx,
            sectionIdx: secIdx,
            resourceId: res.resourceId,
            resourceName: res.resourceName,
            type: res.type,
            finish: res.finish === true || res.finish === 1,
          });
        });
      }
    });
    return list;
  }

  function findFirstUnfinished(resources) {
    for (let i = 0; i < resources.length; i++) {
      if (!resources[i].finish) return resources[i];
    }
    return null;
  }

  function getCurrentResourceIndex(comp, resources) {
    const curIndex = comp.$data.curIndex;
    if (!curIndex || curIndex.length < 2) return -1;
    const chIdx = curIndex[0];
    const secIdx = curIndex[1];
    for (let i = 0; i < resources.length; i++) {
      if (resources[i].chapterIdx === chIdx && resources[i].sectionIdx === secIdx) return i;
    }
    return -1;
  }

  function findNextUnfinished(resources, fromIndex) {
    for (let i = fromIndex + 1; i < resources.length; i++) {
      if (!resources[i].finish) return resources[i];
    }
    return null;
  }

  function switchToSection(comp, chapterIdx, sectionIdx) {
    const courseData = getCourseData(comp);
    const curIndex = comp.curIndex || comp.$data.curIndex;
    if (curIndex && curIndex.length === 2) {
      const isNextSequential =
        (chapterIdx === curIndex[0] && sectionIdx === curIndex[1] + 1) ||
        (chapterIdx === curIndex[0] + 1 && sectionIdx === 0 &&
         curIndex[1] + 1 >= (courseData[curIndex[0]].resourceDTOS || []).length);
      if (isNextSequential && typeof comp.playNextSection === 'function') {
        addLog('调用 playNextSection 切换到下一节', 'info');
        comp.playNextSection();
        return true;
      }
    }
    if (typeof comp.checkoutSection === 'function') {
      const chapter = courseData && courseData[chapterIdx];
      const resource = chapter && chapter.resourceDTOS && chapter.resourceDTOS[sectionIdx];
      if (resource) {
        addLog(`调用 checkoutSection 切换到: ${resource.resourceName}`, 'info');
        comp.checkoutSection(resource, chapterIdx, sectionIdx);
        return true;
      }
    }
    if (typeof comp.jumpPeriod === 'function') {
      const chapter = courseData && courseData[chapterIdx];
      const resource = chapter && chapter.resourceDTOS && chapter.resourceDTOS[sectionIdx];
      if (resource) {
        addLog(`调用 jumpPeriod 切换到: ${resource.resourceName}`, 'info');
        comp.jumpPeriod(resource, chapterIdx, sectionIdx);
        return true;
      }
    }
    const nextEl = document.querySelector('.info-next-text');
    if (nextEl && nextEl.offsetHeight > 0) {
      addLog('点击「下一步」按钮切换章节', 'info');
      nextEl.click();
      return true;
    }
    addLog('所有切换策略均失败', 'error');
    return false;
  }

  function getPostTestConfig() {
    const cfg = getEmbedConfig();
    return {
      enabled: cfg.postTestEnabled !== false,
      requireConfirm: cfg.postTestRequireConfirm !== false,
      skipBank: cfg.postTestSkipBank === true,
      lowConfidenceThreshold: Number(cfg.postTestLowConfidenceThreshold) || 0.65,
      autoSubmitThreshold: Number(cfg.postTestAutoSubmitThreshold) || 0.7,
      model: cfg.postTestModel || 'glm-4-flash',
      apiBaseUrl: cfg.postTestApiBaseUrl || 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      apiKey: cfg.zhipuApiKey || '',
      apiTimeoutMs: Number(cfg.postTestApiTimeoutMs) || 15000,
    };
  }

  function normalizeText(input) {
    return String(input || '')
      .replace(/\s+/g, ' ')
      .replace(/[，。；：！？]/g, (m) => ({ '，': ',', '。': '.', '；': ';', '：': ':', '！': '!', '？': '?' }[m] || m))
      .trim()
      .toLowerCase();
  }

  function hashText(text) {
    let h = 0;
    const str = String(text || '');
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return `q_${Math.abs(h)}`;
  }

  function getAccessibleDocuments() {
    const docs = [{ doc: document, source: 'top' }];
    const iframes = Array.from(document.querySelectorAll('iframe'));
    iframes.forEach((iframe, idx) => {
      try {
        if (iframe.contentDocument) {
          docs.push({ doc: iframe.contentDocument, source: `iframe#${idx + 1}` });
        }
      } catch (_) {}
    });
    return docs;
  }

  function isLikelyLoginDocument(doc) {
    if (!doc) return false;
    const hasLoginForm = !!doc.querySelector('#corpCode, #loginName, #swInput, .login-btn');
    if (hasLoginForm) return true;
    const text = (doc.body?.innerText || '').slice(0, 600).replace(/\s+/g, '');
    return text.includes('密码登录在这里') || text.includes('扫码登录') || text.includes('手机确认登录');
  }

  function findPostTestContext() {
    const docs = getAccessibleDocuments();
    for (const { doc, source } of docs) {
      const title = (doc.querySelector('.course-test-title, .course-test-head, .course-test-wrap .title, h1, h2, .ant-page-header-heading-title')?.textContent || '').trim();
      const bodyText = (doc.body?.innerText || '').slice(0, 1000).replace(/\s+/g, ' ');
      const hasQuestionList = !!doc.querySelector('.course-test-type-list-item, [class*="course-test-type-list-item"]');
      const hasTestWrap = !!doc.querySelector('.course-test-wrap, .course-test-content, [class*="course-test"]');
      const keywordHit = title.includes('课后测试') || title.toLowerCase().includes('post-test')
        || /课后测试|post-test|post test|考试|测验/i.test(bodyText);
      if ((hasQuestionList && hasTestWrap) || keywordHit) {
        return { found: true, doc, source };
      }
    }
    return { found: false, doc: null, source: '' };
  }

  function isPostTestPage() {
    return findPostTestContext().found;
  }

  function findEvaluationContext() {
    const docs = getAccessibleDocuments();
    for (const { doc, source } of docs) {
      if (doc.querySelector('.course-evaluate, .course-evaluate-title')) {
        return { found: true, doc, source };
      }
    }
    return { found: false, doc: null, source: '' };
  }

  function isLoginGatePage() {
    const docs = getAccessibleDocuments();
    return docs.some(({ doc }) => isLikelyLoginDocument(doc));
  }

  function detectQuestionType(item, options) {
    const hasCheckbox = item.querySelector('.ant-checkbox-wrapper');
    const hasRadio = item.querySelector('.ant-radio-wrapper');
    if (hasCheckbox) return 'multiple';
    if (hasRadio && options.length === 2) {
      const text = options.map(o => o.text).join(' ');
      if (/正确|错误|是|否|true|false/i.test(text)) return 'judge';
    }
    return hasRadio ? 'single' : 'single';
  }

  function extractOptionText(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function extractQuestionsForPostTest(doc = null) {
    const targetDoc = doc || findPostTestContext().doc || document;
    // 获取所有匹配选择器的元素
    const allItems = Array.from(targetDoc.querySelectorAll('.course-test-type-list-item, [class*="course-test-type-list-item"]'));
    
    // 只保留最外层的题目容器，过滤掉任何被嵌套在其他容器内部的“假题目”
    const topLevelItems = allItems.filter(item => {
      return !allItems.some(other => other !== item && other.contains(item));
    });

    console.log(`[TBH-PostTest] found ${allItems.length} total list items, filtered to ${topLevelItems.length} top-level questions`);

    return topLevelItems.map((item, index) => {
      const titleEl = item.querySelector('.course-test-type-list-item-title-content') || item.querySelector('.course-test-type-list-item-title');
      const stem = (titleEl ? titleEl.textContent : item.textContent || '').replace(/\s+/g, ' ').trim();
      const optionEls = Array.from(item.querySelectorAll('.ant-radio-wrapper, .ant-checkbox-wrapper'));
      const options = optionEls.map((el, i) => {
        const txt = extractOptionText(el);
        const m = txt.match(/^([A-Z])[\.、\s]/);
        const key = m ? m[1] : String.fromCharCode(65 + i);
        return { key, text: txt };
      });
      return {
        qid: hashText(`${index + 1}|${stem}|${options.map(o => `${o.key}:${o.text}`).join('|')}`),
        index,
        stem,
        type: detectQuestionType(item, options),
        options,
      };
    }).filter(q => q.options.length >= 2 && q.stem.length > 0); // 必须至少有2个选项才视为有效题目
  }

  function loadPostTestBank() {
    try {
      const raw = localStorage.getItem(CONFIG.POSTTEST_BANK_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function savePostTestBank(bank) {
    try {
      localStorage.setItem(CONFIG.POSTTEST_BANK_KEY, JSON.stringify(bank));
    } catch (e) {
      addLog(`题库保存失败：${e.message}`, 'warn');
    }
  }

  function findBankAnswer(bank, question) {
    if (!bank || !question) return null;
    const normalizedStem = normalizeText(question.stem);
    const exact = bank[question.qid];
    if (exact) return exact;

    const candidates = Object.values(bank);
    for (const c of candidates) {
      if (!c || !c.stemNorm) continue;
      if (c.stemNorm === normalizedStem) return c;
    }
    return null;
  }

  function fallbackAnswer(question) {
    if (question.type === 'multiple') {
      const keys = question.options.slice(0, Math.min(2, question.options.length)).map(o => o.key);
      return { answer: keys, confidence: 0.45, reason: 'fallback-multiple' };
    }
    return {
      answer: (question.options[question.options.length - 1] || question.options[0])?.key || 'A',
      confidence: 0.45,
      reason: 'fallback-single',
    };
  }

  function extractJsonArrayFromText(text) {
    if (!text) return null;
    const direct = text.trim();
    try {
      const parsed = JSON.parse(direct);
      return Array.isArray(parsed) ? parsed : null;
    } catch {}

    const match = direct.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function callZhipuSolve(questions, cfg) {
    if (!cfg.apiKey) {
      return { ok: false, error: '未配置 ZHIPU_API_KEY' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.apiTimeoutMs);
    try {
      const payload = {
        model: cfg.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: '你是考试答题助手。只输出 JSON 数组，不要输出其他文字。字段: qid, answer, confidence, reason。single/judge answer 为单个字母，multiple answer 为字母数组。'
          },
          {
            role: 'user',
            content: JSON.stringify({ questions }, null, 2)
          }
        ]
      };

      const resp = await fetch(cfg.apiBaseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        return { ok: false, error: `HTTP ${resp.status} ${errText.slice(0, 200)}` };
      }

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content || '';
      const items = extractJsonArrayFromText(content);
      if (!items) {
        return { ok: false, error: 'AI 返回内容不是有效 JSON 数组' };
      }
      return { ok: true, items };
    } catch (e) {
      return { ok: false, error: e.message || 'AI 请求失败' };
    } finally {
      clearTimeout(timer);
    }
  }

  function normalizeAnswerForType(answer, type) {
    if (type === 'multiple') {
      if (Array.isArray(answer)) return [...new Set(answer.map(a => String(a).toUpperCase()))].sort();
      if (typeof answer === 'string') {
        const arr = answer.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
        return [...new Set(arr)].sort();
      }
      return [];
    }
    if (Array.isArray(answer)) return String(answer[0] || '').toUpperCase();
    return String(answer || '').toUpperCase();
  }

  function findOptionElement(item, targetKey) {
    const wrappers = Array.from(item.querySelectorAll('.ant-radio-wrapper, .ant-checkbox-wrapper'));
    return wrappers.find((el, idx) => {
      const text = extractOptionText(el);
      const m = text.match(/^([A-Z])[\.、\s]/);
      const key = m ? m[1] : String.fromCharCode(65 + idx);
      return key === targetKey;
    }) || null;
  }

  function clearQuestionSelection(item) {
    const checked = item.querySelectorAll('.ant-radio-wrapper-checked, .ant-checkbox-wrapper-checked');
    checked.forEach((el) => {
      const input = el.querySelector('input');
      if (input && input.checked) input.click();
    });
  }

  async function applyPostTestAnswers(plan, doc = null) {
    const targetDoc = doc || findPostTestContext().doc || document;
    const allItems = Array.from(targetDoc.querySelectorAll('.course-test-type-list-item, [class*="course-test-type-list-item"]'));
    // 必须使用与提取时完全一致的过滤逻辑，否则 index 无法对应
    const topLevelItems = allItems.filter(item => {
      return !allItems.some(other => other !== item && other.contains(item));
    });

    console.log(`[TBH-PostTest] applying answers to ${topLevelItems.length} top-level questions`);

    let applied = 0;
    for (const p of plan.items) {
      const item = topLevelItems[p.index];
      if (!item) {
        console.warn(`[TBH-PostTest] item not found at index ${p.index}`);
        continue;
      }
      clearQuestionSelection(item);
      const answerKeys = Array.isArray(p.answer) ? p.answer : [p.answer];
      for (const key of answerKeys) {
        const optionEl = findOptionElement(item, key);
        if (optionEl) {
          const input = optionEl.querySelector('input');
          if (input && !input.checked) input.click();
          else optionEl.click();
          await sleep(150);
        }
      }
      applied++;
      await sleep(200);
    }
    return applied;
  }

  function showPostTestConfirmRow(summary) {
    const row = document.getElementById('tbhConfirmRow');
    const okBtn = document.getElementById('tbhConfirmSubmitBtn');
    if (!row || !okBtn) return;
    row.classList.add('show');
    okBtn.textContent = summary ? `确认提交测试 (${summary})` : '确认提交测试';
  }

  function hidePostTestConfirmRow() {
    const row = document.getElementById('tbhConfirmRow');
    if (!row) return;
    row.classList.remove('show');
  }

  function confirmPostTestSubmit(action) {
    if (!postTestConfirmState.waiting || !postTestConfirmState.resolver) return;
    const resolver = postTestConfirmState.resolver;
    postTestConfirmState.waiting = false;
    postTestConfirmState.resolver = null;
    postTestConfirmState.planSummary = null;
    hidePostTestConfirmRow();
    syncHelperApi();
    resolver(action);
  }

  function waitForPostTestConfirm(timeoutMs, summary) {
    return new Promise((resolve) => {
      postTestConfirmState.waiting = true;
      postTestConfirmState.planSummary = summary || null;
      postTestConfirmState.resolver = resolve;
      showPostTestConfirmRow(summary);
      syncHelperApi();
      setTimeout(() => {
        if (!postTestConfirmState.waiting) return;
        confirmPostTestSubmit('timeout');
      }, timeoutMs);
    });
  }

  function clickPostTestSubmitButton() {
    const targetDoc = findPostTestContext().doc || document;
    const candidates = Array.from(targetDoc.querySelectorAll('button, .ant-btn'));
    const btn = candidates.find((el) => {
      const t = (el.textContent || '').replace(/\s+/g, '');
      return ['提交', '提交测试', '交卷', 'Submit'].includes(t) || t.includes('提交');
    });
    if (!btn) return false;
    btn.click();
    return true;
  }

  function saveLearnedAnswersToBank(plan) {
    const bank = loadPostTestBank();
    plan.items.forEach((item) => {
      bank[item.qid] = {
        qid: item.qid,
        stemNorm: normalizeText(item.stem),
        answer: item.answer,
        confidence: item.confidence,
        source: item.source,
        updatedAt: new Date().toISOString(),
      };
    });
    savePostTestBank(bank);
  }

  async function handlePostTest() {
    const cfg = getPostTestConfig();
    if (!cfg.enabled || !isPostTestPage()) return false;

    // 等待页面完全加载后再开始答题
    addLog('⏳ 检测到课后测试页面，等待 3 秒让页面完全加载...', 'info');
    await sleep(3000);

    // 检测是否存在 "Take Re-take Exam" 按钮（上次答题未通过时出现），自动点击重新考试
    const retakeSelectors = [
      'button.ant-btn.ant-btn-primary',
      '.ant-btn.ant-btn-primary',
    ];
    for (const sel of retakeSelectors) {
      const retakeBtns = document.querySelectorAll(sel);
      for (const btn of retakeBtns) {
        if (btn.textContent && btn.textContent.includes('Take Re-take Exam') && !btn.disabled) {
          console.log('[TBH-PostTest] detected "Take Re-take Exam" button, clicking to re-take exam');
          addLog('🔄 检测到 "Take Re-take Exam" 按钮，自动点击重新考试...', 'info');
          btn.click();
          await sleep(3000); // 等待页面刷新加载新的题目
          break;
        }
      }
    }

    const context = findPostTestContext();
    const postTestDoc = context.doc || document;

    console.log('[TBH-PostTest] detected post-test page, flow starting');
    addLog('🧠 检测到课后测试，开始自动答题流程...', 'success');
    updatePostTestProgress({
      active: true,
      stage: 'detecting',
      summary: `已识别课后测试页面（${context.source || 'top'}）`,
      total: 0,
      resolved: 0,
      fromBank: 0,
      fromAI: 0,
      fromRule: 0,
      avgConfidence: 0,
    });
    updatePostTestProgress({ stage: 'extracting', summary: '正在提取题目...' });
    const questions = extractQuestionsForPostTest(postTestDoc);
    if (questions.length === 0) {
      console.log('[TBH-PostTest] no questions extracted');
      addLog('⚠️ 未提取到测试题目', 'warn');
      updatePostTestProgress({ stage: 'error', active: false, summary: '未提取到题目，请检查页面结构' });
      return false;
    }
    console.log(`[TBH-PostTest] extracted questions: ${questions.length}`);
    addLog(`已提取 ${questions.length} 道题`, 'info');
    updatePostTestProgress({
      stage: 'planning',
      summary: '正在生成答题方案...',
      total: questions.length,
    });

    const bank = loadPostTestBank();
    const unresolved = [];
    const planItems = [];
    if (cfg.skipBank) {
      // 跳过题库，所有题目都交给 AI 解答
      addLog(`POSTTEST_SKIP_BANK=true，跳过题库，全部 ${questions.length} 题交给 AI 解答`, 'info');
      unresolved.push(...questions);
    } else {
      for (const q of questions) {
        const hit = findBankAnswer(bank, q);
        if (hit) {
          planItems.push({
            ...q,
            answer: normalizeAnswerForType(hit.answer, q.type),
            confidence: Math.min(0.99, Number(hit.confidence) || 0.9),
            source: 'bank',
            reason: '题库命中',
          });
        } else {
          unresolved.push(q);
        }
      }
    }
    const fromBankCount = planItems.length;

    if (unresolved.length > 0) {
      const BATCH_SIZE = 5;
      const totalBatches = Math.ceil(unresolved.length / BATCH_SIZE);
      const MAX_RETRY = 3;
      const RETRY_DELAY_MS = 5000;
      addLog(`题库命中 ${questions.length - unresolved.length}/${questions.length}，分 ${totalBatches} 批调用 AI 解答 ${unresolved.length} 题`, 'info');

      for (let i = 0; i < unresolved.length; i += BATCH_SIZE) {
        const batch = unresolved.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        updatePostTestProgress({ stage: 'solving', summary: `正在通过 AI 解答第 ${batchNum}/${totalBatches} 批题目...` });

        let aiRet = { ok: false, error: '' };
        for (let retry = 0; retry < MAX_RETRY; retry++) {
          aiRet = await callZhipuSolve(batch, cfg);
          if (aiRet.ok) break;
          // 429 限流或网络错误时重试
          if (retry < MAX_RETRY - 1 && (aiRet.error?.includes('429') || aiRet.error?.includes('abort') || aiRet.error?.includes('fetch'))) {
            addLog(`⚠️ 第 ${batchNum} 批 AI 请求失败（${aiRet.error}），${RETRY_DELAY_MS / 1000}秒后重试 (${retry + 1}/${MAX_RETRY})`, 'warn');
            await sleep(RETRY_DELAY_MS * (retry + 1)); // 递增延迟
          }
        }
        if (!aiRet.ok) {
          console.log(`[TBH-PostTest] AI batch ${batchNum} solve failed after ${MAX_RETRY} retries: ${aiRet.error}`);
          addLog(`⚠️ 第 ${batchNum} 批 AI 解答失败（已重试 ${MAX_RETRY} 次）：${aiRet.error}，使用兜底答案`, 'warn');
        }

        batch.forEach((q) => {
          const aiItem = aiRet.ok ? (aiRet.items || []).find((it) => it.qid === q.qid) : null;
          if (aiItem) {
            planItems.push({
              ...q,
              answer: normalizeAnswerForType(aiItem.answer, q.type),
              confidence: Math.max(0, Math.min(1, Number(aiItem.confidence) || 0.6)),
              source: 'ai',
              reason: aiItem.reason || 'AI 推理',
            });
          } else {
            const fb = fallbackAnswer(q);
            planItems.push({
              ...q,
              answer: normalizeAnswerForType(fb.answer, q.type),
              confidence: fb.confidence,
              source: 'rule',
              reason: fb.reason,
            });
          }
        });
      }
    }

    planItems.sort((a, b) => a.index - b.index);
    const avgConfidence = planItems.reduce((s, i) => s + Number(i.confidence || 0), 0) / Math.max(1, planItems.length);
    const lowConfidence = planItems.filter(i => Number(i.confidence || 0) < cfg.lowConfidenceThreshold);
    const fromAICount = planItems.filter(i => i.source === 'ai').length;
    const fromRuleCount = planItems.filter(i => i.source === 'rule').length;
    updatePostTestProgress({
      stage: 'applying',
      summary: '正在自动填答...',
      total: planItems.length,
      resolved: planItems.length,
      fromBank: fromBankCount,
      fromAI: fromAICount,
      fromRule: fromRuleCount,
      avgConfidence,
    });

    const applied = await applyPostTestAnswers({ items: planItems }, postTestDoc);
    console.log(`[TBH-PostTest] applied answers: ${applied}/${planItems.length}, avgConfidence=${avgConfidence}`);
    addLog(`✅ 已自动填答 ${applied}/${planItems.length} 题 | 平均置信度 ${(avgConfidence * 100).toFixed(1)}%`, 'success');
    updatePostTestProgress({ stage: 'applying', summary: `已填答 ${applied}/${planItems.length} 题` });
    if (lowConfidence.length > 0) {
      addLog(`⚠️ 低置信度题 ${lowConfidence.length} 道（阈值 ${cfg.lowConfidenceThreshold}）`, 'warn');
    }

    saveLearnedAnswersToBank({ items: planItems });

    let shouldSubmit = !cfg.requireConfirm && avgConfidence >= cfg.autoSubmitThreshold && lowConfidence.length === 0;
    if (!shouldSubmit) {
      const summary = `${(avgConfidence * 100).toFixed(1)}%`;
      addLog('⏸ 等待你点击「确认提交测试」按钮...', 'info');
      updatePostTestProgress({ stage: 'confirming', summary: `等待确认提交（平均置信度 ${summary}）` });
      const action = await waitForPostTestConfirm(CONFIG.POSTTEST_CONFIRM_TIMEOUT_MS, summary);
      console.log(`[TBH-PostTest] confirm action: ${action}`);
      if (action !== 'confirm') {
        addLog(action === 'timeout' ? '确认超时，暂停自动提交' : '你已取消提交，保持当前答题结果', 'warn');
        updatePostTestProgress({ stage: 'error', active: false, summary: action === 'timeout' ? '确认超时，未自动提交' : '你已取消提交' });
        return false;
      }
      shouldSubmit = true;
    }

    if (!shouldSubmit) return false;
    updatePostTestProgress({ stage: 'submitting', summary: '正在提交测试...' });
    const submitted = clickPostTestSubmitButton();
    if (submitted) {
      console.log('[TBH-PostTest] submitted post-test');
      addLog('📤 已提交课后测试', 'success');
      playProgress.courseCompleted = true;
      playProgress.lastActivityAt = new Date().toISOString();
      syncHelperApi();
      addLog('✅ 课后测试已完成，课程状态已标记为完成', 'success');
      updatePostTestProgress({ stage: 'done', active: false, summary: '已提交并完成课后测试' });
      return true;
    }
    console.log('[TBH-PostTest] submit button not found');
    addLog('⚠️ 未找到课后测试提交按钮', 'warn');
    updatePostTestProgress({ stage: 'error', active: false, summary: '未找到提交按钮，请手动检查页面' });
    return false;
  }

  async function startAutoPlay() {
    if (isRunning) return;
    isRunning = true;
    playProgress.startedAt = new Date().toISOString();
    playProgress.lastActivityAt = new Date().toISOString();
    updateUI(true);
    syncHelperApi();
    addLog('🚀 自动播放已启动', 'success');
    startSpeedEnforcer();
    try {
      if (isPostTestPage()) {
        await handlePostTest();
        return;
      }
      const comp = getCoursePlayComponent();
      if (!comp) {
        // 严格模式：先等待组件/资源加载，不直接进入“仅评估/测试模式”（避免 0/0 误判）
        const ready = await waitForResourcesReady();
        if (!ready) {
          addLog('课程组件长期未就绪，切换到评估/测试监听模式', 'warn');
          await waitAndHandleEvaluationOnlyMode();
          return;
        }
      }
      const ready2 = await waitForResourcesReady();
      if (!ready2) {
        addLog('课程资源长期为 0/0，切换到评估/测试监听模式', 'warn');
        await waitAndHandleEvaluationOnlyMode();
        return;
      }

      const resources = ready2.resources;
      const comp2 = ready2.comp;
      addLog(`课程共 ${resources.length} 个资源`, 'info');
      const finished = resources.filter(r => r.finish).length;
      const unfinished = resources.length - finished;
      addLog(`已完成 ${finished}，未完成 ${unfinished}`, finished > 0 ? 'warn' : 'info');
      playProgress.totalResources = resources.length;
      playProgress.finishedResources = finished;
      playProgress.hasSeenResources = resources.length > 0;
      syncHelperApi();
      const curIdx = getCurrentResourceIndex(comp2, resources);
      let startResource;
      if (curIdx >= 0 && !resources[curIdx].finish) {
        startResource = resources[curIdx];
        playProgress.currentResourceName = startResource.resourceName;
        playProgress.currentChapterIdx = startResource.chapterIdx;
        playProgress.currentSectionIdx = startResource.sectionIdx;
        syncHelperApi();
        addLog(`当前正在播放: ${startResource.resourceName}`, 'info');
      } else {
        startResource = findFirstUnfinished(resources);
        if (!startResource) {
        // 如果资源全部完成，先看有没有课后测试或评估
        if (isPostTestPage()) {
          addLog('🧠 所有资源已完成，进入课后测试流程...', 'success');
          await handlePostTest();
          return;
        }
        if (isCourseEvaluatePage()) {
          addLog('📝 所有资源已完成，进入课程评估流程...', 'success');
          await handleCourseEvaluate();
          return;
        }
        
        // 尝试等待一会，看是否有测试/评估按钮延迟跳出
        addLog('⏳ 所有资源已完成，等待测试/评估加载...', 'info');
        await sleep(5000);
        if (isPostTestPage()) {
          addLog('🧠 检测到延迟加载的课后测试，开始答题...', 'success');
          await handlePostTest();
          return;
        }
        if (isCourseEvaluatePage()) {
          addLog('📝 检测到延迟加载的课程评估，开始填写...', 'success');
          await handleCourseEvaluate();
          return;
        }

        // 确定都没有了，才标记课程完成
        if (resources.length > 0 && playProgress.hasSeenResources) {
          playProgress.courseCompleted = true;
          playProgress.finishedResources = resources.length;
          syncHelperApi();
          addLog('🎉 课程内容及后续环节均已确认完成！', 'success');
          stopAutoPlay('course_completed');
          return;
        }
        // 资源为空不允许完成：继续等待资源或后续页面出现
        addLog('⚠️ 当前资源列表为空，无法确认课程完成，继续等待...', 'warn');
        await sleep(3000);
        return;
      }
        addLog(`跳转到未完成内容: ${startResource.resourceName}`, 'warn');
        switchToSection(comp2, startResource.chapterIdx, startResource.sectionIdx);
        await sleep(CONFIG.NEXT_WAIT_MS * 2);
      }
      await playLoop(comp2, resources);
    } catch (e) {
      addLog(`发生异常: ${e.message}`, 'error');
      console.error('[时光易学助手]', e);
    }
    stopAutoPlay('startAutoPlay_end');
  }

  async function waitAndHandleEvaluationOnlyMode(maxWaitMs = 30 * 60 * 1000) {
    addLog('⏳ 仅评估/测试模式：等待页面出现...', 'info');
    updatePostTestProgress({
      active: true,
      stage: 'detecting',
      summary: '等待评估/课后测试页面出现',
      total: 0,
      resolved: 0,
      fromBank: 0,
      fromAI: 0,
      fromRule: 0,
      avgConfidence: 0,
    });
    const startAt = Date.now();
    let loginWarned = false;
    while (isRunning && (Date.now() - startAt) < maxWaitMs) {
      if (isLoginGatePage()) {
        if (!loginWarned) {
          loginWarned = true;
          addLog('⚠️ 当前页面是登录页，学习态可能失效。请先重新登录后再继续。', 'warn');
          updatePostTestProgress({ stage: 'error', active: false, summary: '检测到登录页，请重新登录' });
        }
        await sleep(2000);
        continue;
      }
      if (isPostTestPage()) {
        addLog('🧠 检测到课后测试页面，开始自动答题...', 'success');
        const postTestOk = await handlePostTest();
        if (postTestOk) {
          playProgress.courseCompleted = true;
          playProgress.lastActivityAt = new Date().toISOString();
          syncHelperApi();
          addLog('✅ 仅测试模式执行完成', 'success');
        }
        break;
      }
      if (isCourseEvaluatePage()) {
        addLog('📝 检测到课程评估页面，开始自动填写...', 'success');
        const ok = await handleCourseEvaluate();
        if (ok) {
          playProgress.courseCompleted = true;
          playProgress.lastActivityAt = new Date().toISOString();
          syncHelperApi();
          addLog('✅ 仅评估模式执行完成', 'success');
        }
        break;
      }
      await sleep(2000);
    }
    if (isRunning && !isCourseEvaluatePage() && !isPostTestPage()) {
      addLog('⚠️ 等待评估/测试页面超时，请手动检查页面状态', 'warn');
      updatePostTestProgress({ stage: 'error', active: false, summary: '等待评估/测试页面超时' });
    }
  }

  function stopAutoPlay() {
    const reason = arguments.length ? arguments[0] : 'unknown';
    // 记录停止来源，便于排查“为何一播完就 stop/刷新/重启”
    try {
      lastAction = 'stop_auto_play';
      lastActionAt = new Date().toISOString();
      const stack = (new Error('stopAutoPlay:' + reason).stack || '').split('\n').slice(0, 8).join('\n');
      lastActionDetail = { reason, stack };
    } catch (_) {}

    isRunning = false;
    stopSpeedEnforcer();
    if (postTestConfirmState.waiting) {
      confirmPostTestSubmit('cancel');
    }
    updatePostTestProgress({ active: false, stage: 'idle', summary: '待命' });
    updateUI(false);
    addLog(`⏹ 自动播放已停止（原因：${reason}）`, 'warn');
  }

  async function playLoop(comp, resources) {
    while (isRunning) {
      if (isPostTestPage()) {
        addLog('🧠 检测到课后测试页面，进入自动答题流程...', 'success');
        const postTestOk = await handlePostTest();
        if (postTestOk) {
          playProgress.courseCompleted = true;
          playProgress.lastActivityAt = new Date().toISOString();
          syncHelperApi();
          addLog('✅ 课后测试流程完成，当前课程已完成', 'success');
        }
        break;
      }

      // 关键兜底：即使拿不到 Vue 组件/资源列表，只要 next 按钮出现（你确认是“播完才出现”），就按规则“等3秒→点next”
      // 这能解决：curIndex=null、resources=0 时无法进入推进分支导致的重复播放/误刷新。
      if (findNextButtonEl()) {
        await handleAdvanceByNextButton('playLoop_precheck');
        await sleep(CONFIG.NEXT_WAIT_MS);
        continue;
      }

      const freshComp = getCoursePlayComponent();
      if (!freshComp) { addLog('课程组件丢失，尝试恢复...', 'warn'); await sleep(3000); continue; }
      const freshData = getCourseData(freshComp);
      if (!freshData) { addLog('课程数据丢失，等待...', 'warn'); await sleep(3000); continue; }
      const freshResources = getAllResources(freshData);
      const freshFinished = freshResources.filter(r => r.finish).length;
      const curIdx = getCurrentResourceIndex(freshComp, freshResources);
      if (curIdx < 0) { addLog('无法定位当前播放位置，等待...', 'warn'); await sleep(3000); continue; }
      const current = freshResources[curIdx];

      // 防循环：连续停留在同一资源（可能“下一节”未触发 completed 导致回播）
      const curKey = String(current.resourceId || current.resourceName || '');
      if (curKey && curKey === lastResourceKey) {
        stuckCount++;
      } else {
        lastResourceKey = curKey;
        stuckCount = 0;
      }

      // 回写进度
      playProgress.totalResources = freshResources.length;
      playProgress.finishedResources = freshFinished;
      if (freshResources.length > 0) playProgress.hasSeenResources = true;
      playProgress.currentResourceName = current.resourceName;
      playProgress.currentChapterIdx = current.chapterIdx;
      playProgress.currentSectionIdx = current.sectionIdx;
      // 只有在资源数大于0且全部完成，且没有测试/评估的情况下才算课程完成
      // 如果资源数为0，必须经过评估或测试流程才算完成
      playProgress.courseCompleted = (
        playProgress.hasSeenResources &&
        freshResources.length > 0 &&
        freshFinished === freshResources.length &&
        !isPostTestPage() &&
        !isCourseEvaluatePage()
      );
      playProgress.lastActivityAt = new Date().toISOString();
      syncHelperApi();

      addLog(`▶ 正在播放: ${current.resourceName}`, 'info');
      applySpeed();

      // 混合策略 1：若当前片段已完成，立即跳过到下一节（不等待 3 秒）
      if (current.finish) {
        addLog(`⏩ 当前片段已完成，立即跳过：${current.resourceName}`, 'warn');
        const next = findNextUnfinished(freshResources, curIdx);
        if (!next) {
          addLog('已无未完成片段，等待评估/测试或平台同步...', 'info');
          await sleep(2000);
          continue;
        }
        // 优先组件切换，避免反复点按钮导致循环
        switchToSection(freshComp, next.chapterIdx, next.sectionIdx);
        await sleep(CONFIG.NEXT_WAIT_MS);
        continue;
      }
      const btnResult = await waitForNextButton();
      if (!isRunning) break;
      if (btnResult === 'rewatch') {
        addLog('📖 最后一节内容已完成，等待 8 秒后刷新页面...', 'success');
        let waitSeconds = 0;
        while (waitSeconds < CONFIG.NEXT_BTN_DELAY_MS / 1000 && isRunning) { await sleep(1000); waitSeconds++; addLog(`倒计时 ${CONFIG.NEXT_BTN_DELAY_MS / 1000 - waitSeconds}s...`, 'info'); }
        if (!isRunning) break;
        addLog('🔄 正在刷新页面以同步完成状态...', 'info');
        window.location.reload();
        return;
      }
      if (btnResult === 'evaluate') {
        addLog('📝 进入课程评估自动填写流程...', 'success');
        await handleCourseEvaluate();
        if (!isRunning) break;
        addLog('等待评估提交后的下一步操作...', 'info');
        await sleep(3000);
        const postEvalResult = await waitForNextButton();
        if (!isRunning) break;
        if (postEvalResult === 'rewatch') {
          addLog('📖 评估完成后（最后一节），等待 8 秒后刷新页面...', 'success');
          let ws = 0;
          while (ws < CONFIG.NEXT_BTN_DELAY_MS / 1000 && isRunning) { await sleep(1000); ws++; }
          if (!isRunning) break;
          window.location.reload();
          return;
        }
        if (postEvalResult === false) { addLog('⚠️ 评估提交后未检测到后续按钮', 'warn'); await sleep(3000); }
      }
      if (btnResult === 'posttest') {
        addLog('🧠 检测到课后测试页面，开始自动答题...', 'success');
        const postTestOk = await handlePostTest();
        if (postTestOk) {
          playProgress.courseCompleted = true;
          playProgress.lastActivityAt = new Date().toISOString();
          syncHelperApi();
          addLog('✅ 课后测试流程完成，当前课程已完成', 'success');
        }
        break;
      }
      if (btnResult === false) {
        if (isPostTestPage()) {
          addLog('🧠 检测到课后测试页面（延迟出现），开始自动答题...', 'success');
          const postTestOk = await handlePostTest();
          if (postTestOk) {
            playProgress.courseCompleted = true;
            playProgress.lastActivityAt = new Date().toISOString();
            syncHelperApi();
            addLog('✅ 课后测试流程完成，当前课程已完成', 'success');
          }
          break;
        }
        if (isCourseEvaluatePage()) {
          addLog('📝 检测到课程评估页面（延迟出现），开始自动填写...', 'success');
          await handleCourseEvaluate();
          if (!isRunning) break;
          await sleep(3000);
          continue;
        }
        addLog('⚠️ 未检测到按钮，可能视频未正常结束', 'warn');
        // 卡死兜底：同一片段反复检测未推进，则尝试“播完→3秒→点下一节”，仍失败则刷新
        if (stuckCount >= CONFIG.STUCK_MAX) {
          addLog(`🧷 卡死检测触发（${stuckCount} 次），执行兜底推进...`, 'warn');
          const video = document.querySelector('video');
          const ended = !!(video && video.ended);
          if (ended) {
            // 等待 next 按钮真正出现（你确认“播完才出现”，但可能会有短延迟）
            await waitForNextButtonEl(12000);
            const ok = await handleAdvanceByNextButton('stuck_ended');
            if (!ok) {
              const next = findNextUnfinished(freshResources, curIdx);
              if (next) {
                addLog('未找到按钮，改用组件切换下一节', 'warn');
                switchToSection(freshComp, next.chapterIdx, next.sectionIdx);
              } else {
                addLog('未找到下一未完成片段，刷新页面同步状态', 'warn');
                window.location.reload();
                return;
              }
            }
            stuckCount = 0;
            await sleep(CONFIG.NEXT_WAIT_MS);
            continue;
          }
        }
        await sleep(3000);
        continue;
      }
      // 混合策略 2：当前未完成片段 —— 播完后等待 3 秒，再点击“下一节”触发 completed
      if (btnResult === 'next') {
        // 统一用 handleAdvanceByNextButton，避免逻辑分叉导致“没等3秒/误刷新”
        await handleAdvanceByNextButton('btnResult_next');
        await sleep(CONFIG.NEXT_WAIT_MS);
        continue;
      }
    }
  }

  function waitForNextButton() {
    return new Promise(resolve => {
      let resolved = false;
      const done = (val) => { if (resolved) return; resolved = true; resolve(val); };
      const checkTimer = setInterval(() => {
        if (!isRunning) { clearInterval(checkTimer); done(false); return; }
        if (isPostTestPage()) { clearInterval(checkTimer); addLog('🧠 检测到课后测试页面', 'success'); done('posttest'); return; }
        if (isCourseEvaluatePage()) { clearInterval(checkTimer); addLog('📝 检测到课程评估页面', 'success'); done('evaluate'); return; }
        const nextBtn = document.querySelector('.info-next-text, .next-button');
        if (nextBtn && nextBtn.offsetHeight > 0) { clearInterval(checkTimer); addLog('✅ 「下一步」按钮已出现', 'success'); done('next'); return; }
        // 注意：有些页面可能同时存在 replay 与 next（或 replay 提前出现），这里必须以 next 优先，避免误触发 reload
        const replayBtn = document.querySelector('.replay-btn');
        if (replayBtn && replayBtn.offsetHeight > 0) { clearInterval(checkTimer); addLog('🔄 检测到「重看」按钮（最后一节已完成）', 'success'); done('rewatch'); return; }
        const comp = getVueComponent(document.querySelector('.chapter-container'));
        if (comp && comp.visibleNextClick === true) {
          const replayEl = document.querySelector('.replay-btn');
          if (replayEl && replayEl.offsetHeight > 0) { clearInterval(checkTimer); addLog('🔄 检测到「重看」按钮', 'success'); done('rewatch'); return; }
          const el = document.querySelector('.info-next-text');
          if (el && el.offsetHeight > 0) { clearInterval(checkTimer); addLog('✅ 「下一步」按钮已出现', 'success'); done('next'); return; }
        }
        const video = document.querySelector('video');
        if (video && video.ended) { addLog('视频已结束，等待平台显示按钮...', 'info'); }
      }, 1000);
      setTimeout(() => done(false), 30 * 60 * 1000);
    });
  }

  function clickNextButton() {
    let btn = document.querySelector('.info-next-text');
    if (btn && btn.offsetHeight > 0) { btn.click(); return true; }
    btn = document.querySelector('.next-button');
    if (btn && btn.offsetHeight > 0) { btn.click(); return true; }
    return false;
  }

  async function skipFinishedSections(comp, resources) {
    let maxSkip = 50;
    while (maxSkip-- > 0 && isRunning) {
      await sleep(CONFIG.NEXT_WAIT_MS);
      const freshComp = getCoursePlayComponent();
      if (!freshComp) break;
      const freshData = getCourseData(freshComp);
      if (!freshData) break;
      const freshResources = getAllResources(freshData);
      const curIdx = getCurrentResourceIndex(freshComp, freshResources);
      if (curIdx < 0) break;
      if (freshResources[curIdx].finish) {
        addLog(`⏩ 跳过已完成: ${freshResources[curIdx].resourceName}`, 'warn');
        const next = findNextUnfinished(freshResources, curIdx);
        if (!next) { addLog('🎉 所有课程已全部完成！', 'success'); isRunning = false; break; }
        // 已完成片段：优先组件切换（更稳定，不依赖按钮）
        switchToSection(freshComp, next.chapterIdx, next.sectionIdx);
        // 兜底：组件切换若未生效（例如方法不存在/异常），再尝试点击按钮
        await sleep(CONFIG.NEXT_WAIT_MS);
        const curIdx2 = getCurrentResourceIndex(getCoursePlayComponent() || freshComp, getAllResources(getCourseData(getCoursePlayComponent() || freshComp) || freshData));
        if (curIdx2 === curIdx) {
          const clicked = clickNextButton();
          if (clicked) addLog('组件切换未推进，已改用按钮点击下一节', 'warn');
        }
      } else { break; }
    }
  }

  function isCourseEvaluatePage() {
    return findEvaluationContext().found;
  }

  async function handleCourseEvaluate() {
    const evalContext = findEvaluationContext();
    const evalDoc = evalContext.doc || document;
    addLog('📝 检测到课程评估页面，开始自动填写...', 'success');
    await sleep(1000);
    // 优先复用独立评估模块（固定题目、固定答案）
    try {
      if (window.__TBH_EVAL_AUTO__ && typeof window.__TBH_EVAL_AUTO__.fillAndSubmit === 'function') {
        const result = await window.__TBH_EVAL_AUTO__.fillAndSubmit({
          starRating: 5,
          choiceOption: 'd',
          essayAnswer: '很不错，高效，有趣',
        });
        if (result && result.success) {
          addLog('✅ 课程评估已通过 EvalAuto 模块提交', 'success');
          return true;
        }
        addLog(`⚠️ EvalAuto 未成功，转为兜底提交流程：${result?.error || '未知原因'}`, 'warn');
      }
    } catch (e) {
      addLog(`⚠️ EvalAuto 调用异常，转为兜底提交流程：${e.message}`, 'warn');
    }
    const zeroStar = evalDoc.querySelector('.ant-rate .ant-rate-star-zero');
    if (zeroStar) { zeroStar.click(); addLog('⭐ 已完成课程评分（5星）', 'success'); await sleep(500); }
    else { addLog('⭐ 评分星星已全部选中，跳过', 'info'); }
    const questions = evalDoc.querySelectorAll('.course-test-type-list-item');
    let questionCount = 0;
    questions.forEach((q) => {
      const radioWrappers = q.querySelectorAll('.ant-radio-wrapper');
      if (radioWrappers.length > 0) {
        const lastRadio = radioWrappers[radioWrappers.length - 1];
        const inner = lastRadio.querySelector('.ant-radio-inner');
        if (inner) { inner.click(); questionCount++; }
      }
    });
    addLog(`✅ 已完成 ${questionCount} 道单选题（全部选择最高分）`, 'success');
    await sleep(500);
    const inputDiv = evalDoc.querySelector('.course-test-type-list-item-options-input');
    if (inputDiv) {
      const textarea = inputDiv.querySelector('textarea');
      if (textarea) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeInputValueSetter.call(textarea, '很不错，高效，有趣');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        addLog('💬 已填写文本评价内容', 'success');
        await sleep(500);
      }
    }
    const submitBtn = evalDoc.querySelector('.course-evaluate button.ant-btn-primary:not(.course-header-btn)');
    if (submitBtn) {
      const buttons = evalDoc.querySelectorAll('.course-evaluate button.ant-btn-primary');
      let targetBtn = null;
      buttons.forEach(btn => {
        const text = btn.textContent.trim();
        if (text === 'Submit' || text === '提交' || text === '提交评估' || text === '确 定' || text === '确定') { targetBtn = btn; }
      });
      if (targetBtn) {
        addLog('📤 正在提交课程评估...', 'info');
        targetBtn.click();
        addLog('✅ 课程评估已提交！', 'success');
        await sleep(2000);
        return true;
      }
    }
    addLog('⚠️ 未找到提交按钮', 'warn');
    return false;
  }

  function isCoursePlayPage() {
    const url = window.location.href;
    if (/\/courseLearning\/play/i.test(url) || /\/courseSetting\/.*play/i.test(url)) return true;
    if (isPostTestPage()) return true;
    if (document.querySelector('.chapter-container')) return true;
    if (document.querySelector('.J_prismPlayer')) return true;
    if (document.querySelector('video')) {
      const hasCourseElements =
        document.querySelector('.course-learning') ||
        document.querySelector('.learning-container') ||
        document.querySelector('.section-list') ||
        document.querySelector('.catalogue-wrap');
      if (hasCourseElements) return true;
    }
    return false;
  }

  function tryInjectUI() {
    if (uiInjected) return;
    if (!document.body) return;
    if (!isCoursePlayPage()) return;
    if (document.getElementById('tbhDot')) {
      uiInjected = true;
      syncHelperApi();
      maybeAutoStart();
      return;
    }
    if (!document.querySelector('.chapter-container') && !isPostTestPage()) return;
    uiInjected = true;
    injectUI();
    applyEmbeddedDefaults();
    addLog('时光易学视频助手 v2.3.0 已就绪', 'success');
    addLog(`当前页面: ${window.location.pathname}`, 'info');
    if (getEmbedConfig().autoStart) {
      addLog('已检测到 Skill 内嵌自动播放请求', 'info');
    } else {
      addLog('点击「启动自动播放」按钮开始', 'info');
    }
    syncHelperApi();
    maybeAutoStart();
  }

  function resetInjection() {
    const panel = document.querySelector('.tbh-panel');
    if (panel) panel.remove();
    const style = document.querySelector('style[data-tbh-style]');
    if (style) style.remove();
    uiInjected = false;
    autoStartTriggered = false;
    syncHelperApi();
  }

  function startWatching() {
    const _pushState = history.pushState;
    const _replaceState = history.replaceState;
    history.pushState = function (...args) { _pushState.apply(this, args); onUrlChange(); };
    history.replaceState = function (...args) { _replaceState.apply(this, args); onUrlChange(); };
    window.addEventListener('popstate', onUrlChange);
    checkTimer = setInterval(() => {
      if (window.location.href !== lastUrl) { onUrlChange(); }
      if (!uiInjected) { tryInjectUI(); }
    }, 1500);
    const domObserver = new MutationObserver(() => {
      if (!uiInjected) { tryInjectUI(); }
      else if (!document.getElementById('tbhDot')) { uiInjected = false; tryInjectUI(); }
    });
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function onUrlChange() {
    const newUrl = window.location.href;
    if (newUrl === lastUrl) return;
    console.log('[时光易学助手] URL 变化:', lastUrl, '→', newUrl);
    lastUrl = newUrl;
    if (uiInjected && !isCoursePlayPage()) { resetInjection(); return; }
    tryInjectUI();
  }

  function boot() {
    console.log('[时光易学助手] 脚本已加载, 当前URL:', window.location.href);
    syncHelperApi();
    tryInjectUI();
    if (!uiInjected) {
      let retryCount = 0;
      const retryTimer = setInterval(() => {
        retryCount++;
        tryInjectUI();
        if (uiInjected || retryCount > 20) { clearInterval(retryTimer); }
      }, 1000);
    }
    startWatching();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') { boot(); }
  else { window.addEventListener('DOMContentLoaded', boot); }
})();
