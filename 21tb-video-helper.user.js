// ==UserScript==
// @name         时光易学视频助手2.0
// @namespace    https://greasyfork.org/users/cacao
// @version      2.2.0
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
    startedAt: null,
    lastActivityAt: null,
  };

  function getEmbedConfig() {
    return window.__TBH_EMBED_CONFIG__ || {};
  }

  function syncHelperApi() {
    window.__TBH_HELPER__ = {
      version: '2.2.0',
      start: startAutoPlay,
      stop: stopAutoPlay,
      getState: () => ({
        isRunning,
        currentSpeed,
        uiInjected,
        autoStartTriggered,
        mode: getEmbedConfig().source || 'userscript',
        autoStart: !!getEmbedConfig().autoStart,
        url: window.location.href,
        progress: { ...playProgress },
      }),
    };
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
  }

  function maybeAutoStart() {
    const cfg = getEmbedConfig();
    if (!cfg.autoStart || autoStartTriggered || isRunning || !uiInjected) return;
    autoStartTriggered = true;
    syncHelperApi();
    const delay = Number(cfg.autoStartDelayMs) > 0 ? Number(cfg.autoStartDelayMs) : 1800;
    addLog(`检测到 Skill 内嵌模式，${Math.round(delay / 100) / 10}s 后自动启动`, 'info');
    window.setTimeout(() => {
      if (!document.getElementById('tbhStartBtn') || isRunning) return;
      addLog('🤖 由 Skill 内置播放助手自动启动', 'success');
      startAutoPlay();
    }, delay);
  }

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
      </div>
      <div class="tbh-body" id="tbhLogArea"></div>
    `;
    document.body.appendChild(panel);

    bindUIEvents();
  }

  function bindUIEvents() {
    const startBtn = document.getElementById('tbhStartBtn');
    const speedDownBtn = document.getElementById('tbhSpeedDown');
    const speedUpBtn = document.getElementById('tbhSpeedUp');
    const minBtn = document.getElementById('tbhMinBtn');

    startBtn.addEventListener('click', () => {
      isRunning ? stopAutoPlay() : startAutoPlay();
    });
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
    while (node && !node.__vue__) { node = node.parentElement; }
    return node ? node.__vue__ : null;
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

  function getCoursePlayComponent() {
    const el = document.querySelector('.chapter-container');
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

  async function startAutoPlay() {
    if (isRunning) return;
    isRunning = true;
    playProgress.startedAt = new Date().toISOString();
    playProgress.lastActivityAt = new Date().toISOString();
    updateUI(true);
    syncHelperApi();
    addLog('🚀 自动播放已启动', 'success');
    try {
      const comp = getCoursePlayComponent();
      if (!comp) {
        addLog('未找到课程组件，切换到评估监听模式', 'warn');
        await waitAndHandleEvaluationOnlyMode();
        return;
      }
      const courseData = getCourseData(comp);
      if (!courseData) {
        addLog('未找到课程数据，切换到评估监听模式', 'warn');
        await waitAndHandleEvaluationOnlyMode();
        return;
      }
      const resources = getAllResources(courseData);
      addLog(`课程共 ${resources.length} 个资源`, 'info');
      const finished = resources.filter(r => r.finish).length;
      const unfinished = resources.length - finished;
      addLog(`已完成 ${finished}，未完成 ${unfinished}`, finished > 0 ? 'warn' : 'info');
      playProgress.totalResources = resources.length;
      playProgress.finishedResources = finished;
      syncHelperApi();
      const curIdx = getCurrentResourceIndex(comp, resources);
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
          playProgress.courseCompleted = true;
          playProgress.finishedResources = resources.length;
          syncHelperApi();
          addLog('🎉 所有课程已全部完成！', 'success');
          stopAutoPlay();
          return;
        }
        addLog(`跳转到未完成内容: ${startResource.resourceName}`, 'warn');
        switchToSection(comp, startResource.chapterIdx, startResource.sectionIdx);
        await sleep(CONFIG.NEXT_WAIT_MS * 2);
      }
      await playLoop(comp, resources);
    } catch (e) {
      addLog(`发生异常: ${e.message}`, 'error');
      console.error('[时光易学助手]', e);
    }
    stopAutoPlay();
  }

  async function waitAndHandleEvaluationOnlyMode(maxWaitMs = 30 * 60 * 1000) {
    addLog('⏳ 仅评估模式：等待课程评估页面出现...', 'info');
    const startAt = Date.now();
    while (isRunning && (Date.now() - startAt) < maxWaitMs) {
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
    if (isRunning && !isCourseEvaluatePage()) {
      addLog('⚠️ 等待评估页面超时，请手动检查页面状态', 'warn');
    }
  }

  function stopAutoPlay() {
    isRunning = false;
    updateUI(false);
    addLog('⏹ 自动播放已停止', 'warn');
  }

  async function playLoop(comp, resources) {
    while (isRunning) {
      const freshComp = getCoursePlayComponent();
      if (!freshComp) { addLog('课程组件丢失，尝试恢复...', 'warn'); await sleep(3000); continue; }
      const freshData = getCourseData(freshComp);
      if (!freshData) { addLog('课程数据丢失，等待...', 'warn'); await sleep(3000); continue; }
      const freshResources = getAllResources(freshData);
      const freshFinished = freshResources.filter(r => r.finish).length;
      const curIdx = getCurrentResourceIndex(freshComp, freshResources);
      if (curIdx < 0) { addLog('无法定位当前播放位置，等待...', 'warn'); await sleep(3000); continue; }
      const current = freshResources[curIdx];

      // 回写进度
      playProgress.totalResources = freshResources.length;
      playProgress.finishedResources = freshFinished;
      playProgress.currentResourceName = current.resourceName;
      playProgress.currentChapterIdx = current.chapterIdx;
      playProgress.currentSectionIdx = current.sectionIdx;
      playProgress.courseCompleted = (freshFinished === freshResources.length);
      playProgress.lastActivityAt = new Date().toISOString();
      syncHelperApi();

      addLog(`▶ 正在播放: ${current.resourceName}`, 'info');
      applySpeed();
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
      if (btnResult === false) {
        if (isCourseEvaluatePage()) {
          addLog('📝 检测到课程评估页面（延迟出现），开始自动填写...', 'success');
          await handleCourseEvaluate();
          if (!isRunning) break;
          await sleep(3000);
          continue;
        }
        addLog('⚠️ 未检测到按钮，可能视频未正常结束', 'warn');
        await sleep(3000);
      }
      addLog('等待 8 秒后点击「下一步」...', 'info');
      let waitSeconds = 0;
      while (waitSeconds < CONFIG.NEXT_BTN_DELAY_MS / 1000 && isRunning) { await sleep(1000); waitSeconds++; addLog(`倒计时 ${CONFIG.NEXT_BTN_DELAY_MS / 1000 - waitSeconds}s...`, 'info'); }
      if (!isRunning) break;
      const nextUnfinished = findNextUnfinished(freshResources, curIdx);
      if (!nextUnfinished) {
        playProgress.courseCompleted = true;
        playProgress.finishedResources = freshResources.length;
        syncHelperApi();
        addLog('🎉 所有课程已全部完成！', 'success');
        break;
      }
      let clicked = clickNextButton();
      if (clicked) { addLog(`已点击下一节 → ${nextUnfinished.resourceName}`, 'success'); }
      else { addLog('未找到下一节按钮，尝试 Vue 方法切换', 'warn'); switchToSection(freshComp, nextUnfinished.chapterIdx, nextUnfinished.sectionIdx); }
      addLog('等待下一节加载...', 'info');
      await sleep(CONFIG.NEXT_WAIT_MS);
      await skipFinishedSections(freshComp, freshResources);
    }
  }

  function waitForNextButton() {
    return new Promise(resolve => {
      let resolved = false;
      const done = (val) => { if (resolved) return; resolved = true; resolve(val); };
      const checkTimer = setInterval(() => {
        if (!isRunning) { clearInterval(checkTimer); done(false); return; }
        if (isCourseEvaluatePage()) { clearInterval(checkTimer); addLog('📝 检测到课程评估页面', 'success'); done('evaluate'); return; }
        const replayBtn = document.querySelector('.replay-btn');
        if (replayBtn && replayBtn.offsetHeight > 0) { clearInterval(checkTimer); addLog('🔄 检测到「重看」按钮（最后一节已完成）', 'success'); done('rewatch'); return; }
        const nextBtn = document.querySelector('.info-next-text, .next-button');
        if (nextBtn && nextBtn.offsetHeight > 0) { clearInterval(checkTimer); addLog('✅ 「下一步」按钮已出现', 'success'); done('next'); return; }
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
        const clicked = clickNextButton();
        if (!clicked) { switchToSection(freshComp, next.chapterIdx, next.sectionIdx); }
      } else { break; }
    }
  }

  function isCourseEvaluatePage() {
    return !!(document.querySelector('.course-evaluate') || document.querySelector('.course-evaluate-title'));
  }

  async function handleCourseEvaluate() {
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
    const zeroStar = document.querySelector('.ant-rate .ant-rate-star-zero');
    if (zeroStar) { zeroStar.click(); addLog('⭐ 已完成课程评分（5星）', 'success'); await sleep(500); }
    else { addLog('⭐ 评分星星已全部选中，跳过', 'info'); }
    const questions = document.querySelectorAll('.course-test-type-list-item');
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
    const inputDiv = document.querySelector('.course-test-type-list-item-options-input');
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
    const submitBtn = document.querySelector('.course-evaluate button.ant-btn-primary:not(.course-header-btn)');
    if (submitBtn) {
      const buttons = document.querySelectorAll('.course-evaluate button.ant-btn-primary');
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
    if (!document.querySelector('.chapter-container')) return;
    uiInjected = true;
    injectUI();
    applyEmbeddedDefaults();
    addLog('时光易学视频助手 v2.2.0 已就绪', 'success');
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
