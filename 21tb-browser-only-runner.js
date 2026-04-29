/* eslint-disable no-var */
/**
 * 21tb Browser-only Runner（面向 Agent 内置浏览器）
 *
 * 设计目标：
 * - 不依赖 Puppeteer、不要求额外安装/下载浏览器
 * - 仅依赖“在 21tb 页面里注入一段 JS”（由 Agent 执行 browser_evaluate）
 * - 默认：只完成指定课程并停下回报
 * - 用户输入“下一门/继续”时：自动推进下一门未完成课程（仍然单课串行）
 *
 * 使用方式：
 * 1) 在课程中心页（My Courses）执行：
 *    window.__TBH_RUNNER_CONFIG__ = { ... }  // 可选
 *    加载本脚本（script src=GitHub Raw）
 * 2) 调用：
 *    window.__TBH_RUNNER__.startCourseByName('课程名')
 *
 * Runner 与 helper 的关系：
 * - helper 仍负责播放/评估/课后测试的具体自动化；
 * - runner 负责：找课 → 打开播放页（允许新 tab）→ 注入 helper/eval → 轮询状态 → 处理 post-test 对话确认。
 */
(function () {
  'use strict';

  if (window.__TBH_RUNNER__ && window.__TBH_RUNNER__.version) {
    // 已加载过
    return;
  }

  // ========================
  // 跨窗口监听（用于 Trae “独立播放窗口”无法打开 DevTools 的场景）
  // ========================
  var CHANNEL_NAME = 'TBH_CHANNEL_V1';
  var lastBroadcast = null;
  var bc = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel(CHANNEL_NAME);
      bc.onmessage = function (ev) {
        try {
          var data = ev && ev.data;
          if (!data || data.type !== 'TBH_STATE') return;
          lastBroadcast = data;
        } catch (_) {}
      };
    }
  } catch (_) {
    bc = null;
  }

  var DEFAULTS = {
    // 注入行为
    autoStart: true,
    autoStartDelayMs: 1800,
    defaultSpeed: 16,
    autoEval: true,

    // post-test
    postTestEnabled: true,
    postTestRequireConfirm: true,
    postTestLowConfidenceThreshold: 0.65,
    postTestAutoSubmitThreshold: 0.7,
    postTestModel: 'glm-4-flash',
    postTestApiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    postTestApiTimeoutMs: 60000,
    zhipuApiKey: '',

    // 资源地址（建议固定 tag/commit）
    helperUrl: '',
    evalAutoUrl: '',

    // 运行策略
    closeCourseTabOnComplete: true,
    pollMs: 10000,
    injectTimeoutMs: 45000,
    // 某些环境下新窗口加载较慢，默认放宽
    openTimeoutMs: 120000,
    debug: false,
  };

  function nowIso() {
    try { return new Date().toISOString(); } catch { return ''; }
  }

  function log() {
    if (!state.config.debug) return;
    try {
      // eslint-disable-next-line no-console
      console.log('[TBH-RUNNER]', ...arguments);
    } catch {}
  }

  function emit(type, detail) {
    try {
      window.dispatchEvent(new CustomEvent('tbh-runner', { detail: { type: type, at: nowIso(), ...detail } }));
    } catch {}
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function merge(target, src) {
    if (!src) return target;
    for (var k in src) target[k] = src[k];
    return target;
  }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function isCourseCenterPage() {
    return /courseCenter\.loadStudyTask/i.test(location.href) || /NEW_COURSE_CENTER/.test(location.href);
  }

  function isLoginPage() {
    return /\/login\/login\.init\.do/i.test(location.href);
  }

  function selectOne(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = document.querySelector(selectors[i]);
        if (el) return el;
      } catch {}
    }
    return null;
  }

  async function maybeAutoLogin() {
    // 仅在登录页尝试自动登录；如果缺少凭据则抛错提示 Agent 询问用户
    if (!isLoginPage()) return true;

    var cfg = state.config;
    var enterprise = String(cfg.enterpriseId || cfg.enterprise || '').trim();
    var username = String(cfg.username || cfg.user || '').trim();
    var password = String(cfg.password || cfg.pass || '').trim();

    if (!enterprise || !username || !password) {
      throw new Error('缺少登录凭据：enterpriseId/username/password（可由 Agent 从 .env 读取后注入到 __TBH_RUNNER_CONFIG__）');
    }

    emit('phase', { phase: 'login_start' });

    // 优先调用页面内置函数切换到密码登录；不行再点击提示
    try { if (typeof window.noErwei === 'function') window.noErwei(); } catch {}
    try {
      if (typeof window.changeWay === 'function') {
        var tab = document.getElementById('login-password') || null;
        window.changeWay(1, tab);
      }
    } catch {}

    // 兜底：点击“Password login here”
    try {
      var btn = Array.from(document.querySelectorAll('a,button,span,div')).find(function (el) {
        return (el.innerText || '').toLowerCase().indexOf('password login') >= 0;
      });
      if (btn) btn.click();
    } catch {}

    await sleep(600);

    // 输入框
    var corpEl = selectOne(['#corpCode', 'input[name=corpCode]', 'input[placeholder*=Company]']);
    var userEl = selectOne(['#loginName', 'input[name=loginName]', 'input[placeholder*=Username]']);
    var passEl = selectOne(['#swInput', 'input[type=password]', 'input[placeholder*=Password]']);

    if (!corpEl || !userEl || !passEl) {
      throw new Error('未找到登录表单输入框（可能页面结构变化/仍在二维码页）');
    }

    var setVal = function (el, val) {
      try {
        el.focus();
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      } catch {}
    };

    setVal(corpEl, enterprise);
    setVal(userEl, username);
    setVal(passEl, password);

    // 提交按钮
    var submit = selectOne(['.login-btn', 'button[type=submit]', 'button[name=submit]']);
    if (submit) submit.click();

    // 等待跳转离开 login 页（最多 30 秒）
    var navStart = Date.now();
    while (Date.now() - navStart < 30000) {
      try {
        if (!/\/login\/login\.init\.do/i.test(location.href)) break;
      } catch {}
      await sleep(500);
    }

    // 若出现 “Continue/Cancel” 弹窗，点 Continue
    var start = Date.now();
    while (Date.now() - start < 15000) {
      try {
        var cont = Array.from(document.querySelectorAll('button')).find(function (b) {
          return (b.innerText || '').trim().toLowerCase() === 'continue';
        });
        if (cont) { cont.click(); break; }
      } catch {}
      await sleep(500);
    }

    emit('phase', { phase: 'login_submitted' });
    return true;
  }

  async function ensureCourseCenterReady() {
    var target = 'https://v4.21tb.com/els/html/index.parser.do?id=NEW_COURSE_CENTER&current_app_id=8a80810f5ab29060015ad1906d0b3811#!/els/html/courseCenter/courseCenter.loadStudyTask.do';

    for (var i = 0; i < 120; i++) { // 最多等 60s
      if (isCourseCenterPage()) return true;

      if (isLoginPage()) {
        await maybeAutoLogin();
        // 登录后不管跳到哪里，都强制去课程中心（避免停在 OS 首页）
        try { location.href = target; } catch {}
      } else {
        // 已登录但不在课程中心：跳转到课程中心
        try { location.href = target; } catch {}
      }

      await sleep(500);
    }

    throw new Error('进入课程中心超时（请检查是否登录成功/是否出现验证码或弹窗拦截）');
  }

  function ensureAbsolute(url) {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('//')) return location.protocol + url;
    return url;
  }

  async function loadScriptIntoWindow(targetWindow, src) {
    return new Promise(function (resolve, reject) {
      try {
        var d = targetWindow.document;
        var s = d.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = function () { resolve(true); };
        s.onerror = function () { reject(new Error('load failed: ' + src)); };
        (d.head || d.documentElement).appendChild(s);
      } catch (e) {
        reject(e);
      }
    });
  }

  async function fetchJson(url) {
    try {
      var res = await fetch(url, { credentials: 'include' });
      var text = await res.text();
      var data = safeJsonParse(text);
      return { ok: res.ok, status: res.status, data: data, text: text };
    } catch (e) {
      return { ok: false, status: 0, data: null, text: String(e && e.message ? e.message : e) };
    }
  }

  function extractCourseListFromApiPayload(payload) {
    // 兼容多种响应结构，尽量提取数组
    if (!payload) return [];
    var candidates = [];
    var pushArr = function (arr) { if (Array.isArray(arr)) candidates.push(arr); };

    // 常见字段
    pushArr(payload.list);
    pushArr(payload.rows);
    pushArr(payload.data);
    if (payload.data) {
      pushArr(payload.data.list);
      pushArr(payload.data.rows);
      pushArr(payload.data.result);
      pushArr(payload.data.records);
    }
    pushArr(payload.result);
    if (payload.result) {
      pushArr(payload.result.list);
      pushArr(payload.result.rows);
      pushArr(payload.result.result);
      pushArr(payload.result.records);
    }

    // 兜底：扫描对象树第一层数组
    for (var k in payload) {
      if (Array.isArray(payload[k])) candidates.push(payload[k]);
    }

    // 选择“元素是对象且长度最大”的那一个
    var best = [];
    for (var i = 0; i < candidates.length; i++) {
      var arr = candidates[i];
      if (!Array.isArray(arr) || arr.length === 0) continue;
      if (typeof arr[0] !== 'object') continue;
      if (arr.length > best.length) best = arr;
    }
    return best;
  }

  function normalizeCourseItem(item) {
    if (!item || typeof item !== 'object') return null;
    var title =
      item.title ||
      item.courseName ||
      item.name ||
      (item.courseInfo && (item.courseInfo.courseName || item.courseInfo.name)) ||
      '';
    title = String(title || '').trim();

    var id =
      item.courseId ||
      item.id ||
      item.course_id ||
      (item.courseInfo && (item.courseInfo.courseId || item.courseInfo.id)) ||
      '';
    id = String(id || '').trim();

    // 进度/状态可能有不同字段
    var progressText =
      item.progressText ||
      item.progress ||
      item.studyProgress ||
      (item.courseStudyRecord && item.courseStudyRecord.progress) ||
      '';

    var finished =
      item.isFinished === true ||
      item.finished === true ||
      item.complete === true ||
      /finish|completed/i.test(String(progressText));

    return { id: id, title: title, raw: item, finished: finished };
  }

  async function fetchAllCourses(maxPages) {
    // 使用课程中心接口（同域、带 cookie）
    // 观察到的请求：
    // /els/html/courseCenter/courseCenter.studyTaskList.do?...&page.pageNo=1...
    var all = [];
    var pageNo = 1;
    var max = Number(maxPages) || 20;

    while (pageNo <= max) {
      var url = '/els/html/courseCenter/courseCenter.studyTaskList.do'
        + '?courseType=NEW_COURSE_CENTER'
        + '&page.pageSize=12'
        + '&page.sortName=STUDYTIME'
        + '&courseStudyRecord.filterPartyClass=false'
        + '&categoryId='
        + '&courseStudyRecord.getWay='
        + '&courseStudyRecord.srcName='
        + '&courseStudyRecord.courseStudyType='
        + '&courseStudyRecord.stepToGetScore='
        + '&courseStudyRecord.courseStatus='
        + '&courseStudyRecord.courseInfo.terminal='
        + '&page.pageNo=' + pageNo
        + '&current_app_id='
        + '&_=' + Date.now();

      var resp = await fetchJson(url);
      if (!resp.ok || !resp.data) break;
      var list = extractCourseListFromApiPayload(resp.data);
      if (!list || list.length === 0) break;

      for (var i = 0; i < list.length; i++) {
        var c = normalizeCourseItem(list[i]);
        if (c && c.title) all.push(c);
      }

      // 粗略终止：不足一页就结束
      if (list.length < 12) break;
      pageNo++;
      await sleep(200);
    }

    // 去重（按 id 优先）
    var seen = {};
    var out = [];
    for (var j = 0; j < all.length; j++) {
      var key = all[j].id || all[j].title;
      if (!key) continue;
      if (seen[key]) continue;
      seen[key] = true;
      out.push(all[j]);
    }
    return out;
  }

  function findCourseByName(courses, name) {
    var n = String(name || '').trim();
    if (!n) return null;
    for (var i = 0; i < courses.length; i++) {
      if (courses[i].title === n) return courses[i];
    }
    // 模糊匹配
    for (var j = 0; j < courses.length; j++) {
      if (courses[j].title && courses[j].title.indexOf(n) >= 0) return courses[j];
    }
    return null;
  }

  function pickNextUnfinished(courses) {
    for (var i = 0; i < courses.length; i++) {
      if (!courses[i].finished) return courses[i];
    }
    return null;
  }

  function buildPlayUrl(courseId) {
    return 'https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId=' + encodeURIComponent(courseId);
  }

  async function openCourseTab(url) {
    state.phase = 'opening_course';
    state.courseTab = null;
    state.courseUrl = url;
    emit('phase', { phase: state.phase, courseUrl: url });

    var w = null;
    try {
      w = window.open(url, '_blank');
    } catch (e) {
      state.phase = 'error';
      state.error = 'window.open 失败：' + (e && e.message ? e.message : String(e));
      emit('error', { error: state.error });
      throw e;
    }

    state.courseTab = w;

    var start = Date.now();
    while (Date.now() - start < state.config.openTimeoutMs) {
      try {
        if (!w) break;
        if (!w.closed) {
          // 某些内置浏览器对新开 tab 的 URL/快照能力较弱，这里不强依赖 href 判断，
          // 只要能拿到 document 且 readyState 非 loading，就认为页面已可注入。
          if (w.document && w.document.readyState && w.document.readyState !== 'loading') {
            return w;
          }
        }
      } catch (e2) {
        // ignore
      }
      await sleep(300);
    }

    state.phase = 'error';
    state.error = w ? '打开课程页超时（可能新窗口未完全加载/被弹窗拦截）' : 'window.open 失败（可能被浏览器策略拦截）';
    emit('error', { error: state.error });
    throw new Error(state.error);
  }

  async function injectHelperIntoCourseTab(w) {
    state.phase = 'injecting';
    state.injected = false;
    emit('phase', { phase: state.phase });

    var cfg = state.config;
    if (!cfg.helperUrl || !cfg.evalAutoUrl) {
      throw new Error('缺少 helperUrl/evalAutoUrl（需要 https 可访问地址）');
    }

    try {
      w.__TBH_EMBED_CONFIG__ = {
        autoStart: cfg.autoStart,
        autoStartDelayMs: cfg.autoStartDelayMs,
        defaultSpeed: cfg.defaultSpeed,
        source: 'agent-browser-only',
        autoEval: cfg.autoEval,
        postTestEnabled: cfg.postTestEnabled,
        postTestRequireConfirm: cfg.postTestRequireConfirm,
        postTestLowConfidenceThreshold: cfg.postTestLowConfidenceThreshold,
        postTestAutoSubmitThreshold: cfg.postTestAutoSubmitThreshold,
        postTestModel: cfg.postTestModel,
        postTestApiBaseUrl: cfg.postTestApiBaseUrl,
        postTestApiTimeoutMs: cfg.postTestApiTimeoutMs,
        zhipuApiKey: cfg.zhipuApiKey,
      };
    } catch (e) {
      // ignore
    }

    // 先把 embed config 写入子窗口（helper 会读取）
    try { w.__TBH_EMBED_CONFIG__ = w.__TBH_EMBED_CONFIG__ || {}; } catch {}

    await loadScriptIntoWindow(w, ensureAbsolute(cfg.helperUrl));
    if (cfg.autoEval) {
      await loadScriptIntoWindow(w, ensureAbsolute(cfg.evalAutoUrl));
    }

    var start = Date.now();
    while (Date.now() - start < cfg.injectTimeoutMs) {
      try {
        if (w.__TBH_HELPER__ && typeof w.__TBH_HELPER__.getState === 'function') {
          state.injected = true;
          emit('injected', { ok: true });
          return true;
        }
      } catch (e2) {
        // ignore
      }
      await sleep(300);
    }

    state.injected = false;
    emit('injected', { ok: false });
    throw new Error('注入超时：未检测到 window.__TBH_HELPER__');
  }

  async function monitorUntilComplete() {
    state.phase = 'playing';
    emit('phase', { phase: state.phase });

    while (!state.stopped) {
      var w = state.courseTab;
      if (!w || w.closed) {
        state.phase = 'error';
        state.error = '课程标签页被关闭';
        emit('error', { error: state.error });
        throw new Error(state.error);
      }

      var helperState = null;
      try {
        helperState = w.__TBH_HELPER__ && w.__TBH_HELPER__.getState ? w.__TBH_HELPER__.getState() : null;
      } catch (e) {
        helperState = null;
      }

      if (helperState) {
        state.helperState = helperState;
        var p = helperState.progress || {};
        state.progress = p;
        state.postTestConfirm = helperState.postTestConfirm || { waiting: false, summary: '' };

        emit('tick', {
          courseTitle: state.currentCourse && state.currentCourse.title,
          finishedResources: p.finishedResources,
          totalResources: p.totalResources,
          currentResourceName: p.currentResourceName,
          courseCompleted: !!p.courseCompleted,
          postTestWaiting: !!(state.postTestConfirm && state.postTestConfirm.waiting),
        });

        if (state.postTestConfirm && state.postTestConfirm.waiting && state.config.postTestRequireConfirm) {
          state.phase = 'awaiting_posttest_confirm';
          emit('posttest_confirm_required', { summary: state.postTestConfirm.summary || '' });
          // 等待外部调用 resolvePostTestConfirm
          while (!state.stopped && state.phase === 'awaiting_posttest_confirm') {
            await sleep(500);
          }
        }

        if (p.courseCompleted) {
          state.phase = 'completed';
          emit('completed', { courseTitle: state.currentCourse && state.currentCourse.title });
          if (state.config.closeCourseTabOnComplete) {
            try { w.close(); } catch {}
          }
          return true;
        }
      }

      await sleep(state.config.pollMs);
    }

    return false;
  }

  async function runCourse(course) {
    state.currentCourse = course;
    state.error = '';
    state.progress = null;
    state.postTestConfirm = { waiting: false, summary: '' };
    state.helperState = null;

    emit('course_start', { courseTitle: course.title, courseId: course.id });

    var url = buildPlayUrl(course.id);
    var w = await openCourseTab(url);
    await injectHelperIntoCourseTab(w);
    return monitorUntilComplete();
  }

  async function ensureInCourseCenter() {
    if (isCourseCenterPage()) return true;
    // 如果还在 login 页，交给 Agent 完成登录；runner 只做提示
    if (isLoginPage()) {
      // 允许自动登录
      await maybeAutoLogin();
      return false;
    }
    // 兜底：跳课程中心
    location.href = 'https://v4.21tb.com/els/html/index.parser.do?id=NEW_COURSE_CENTER&current_app_id=8a80810f5ab29060015ad1906d0b3811#!/els/html/courseCenter/courseCenter.loadStudyTask.do';
    return false;
  }

  // ========================
  // 公共 API
  // ========================
  var state = {
    version: '0.1.1',
    phase: 'idle',
    stopped: false,
    error: '',
    injected: false,
    courseUrl: '',
    currentCourse: null,
    courseTab: null,
    helperState: null,
    progress: null,
    postTestConfirm: { waiting: false, summary: '' },
    config: merge(merge({}, DEFAULTS), window.__TBH_RUNNER_CONFIG__ || {}),
  };

  async function startCourseByName(name) {
    state.stopped = false;
    state.phase = 'preparing';
    emit('phase', { phase: state.phase, targetName: name });

    await ensureCourseCenterReady();

    state.phase = 'fetching_courses';
    emit('phase', { phase: state.phase });
    var courses = await fetchAllCourses(30);
    state.courses = courses;

    var course = findCourseByName(courses, name);
    if (!course) {
      state.phase = 'error';
      state.error = '未找到课程：' + name;
      emit('error', { error: state.error });
      throw new Error(state.error);
    }

    await runCourse(course);
    return true;
  }

  async function nextCourse() {
    state.stopped = false;
    await ensureCourseCenterReady();
    state.phase = 'fetching_courses';
    emit('phase', { phase: state.phase });
    var courses = await fetchAllCourses(30);
    state.courses = courses;
    var next = pickNextUnfinished(courses);
    if (!next) {
      state.phase = 'completed';
      emit('completed', { courseTitle: '(no more unfinished)' });
      return false;
    }
    await runCourse(next);
    return true;
  }

  function resolvePostTestConfirm(action) {
    var act = String(action || '').toLowerCase();
    if (state.phase !== 'awaiting_posttest_confirm') return false;
    var w = state.courseTab;
    if (!w || w.closed || !w.__TBH_HELPER__) return false;
    try {
      if (act === 'confirm') w.__TBH_HELPER__.approvePostTestSubmit();
      if (act === 'cancel') w.__TBH_HELPER__.rejectPostTestSubmit();
      emit('posttest_confirm_resolved', { action: act });
      state.phase = 'playing';
      return true;
    } catch (e) {
      state.error = '确认操作失败：' + (e && e.message ? e.message : String(e));
      emit('error', { error: state.error });
      return false;
    }
  }

  function stop() {
    state.stopped = true;
    state.phase = 'stopped';
    emit('phase', { phase: state.phase });
    return true;
  }

  function configure(cfg) {
    state.config = merge(state.config, cfg || {});
    emit('config', { updated: true });
    return true;
  }

  function getState() {
    return {
      version: state.version,
      phase: state.phase,
      stopped: state.stopped,
      error: state.error,
      injected: state.injected,
      currentCourse: state.currentCourse,
      progress: state.progress,
      postTestConfirm: state.postTestConfirm,
      config: {
        autoStart: state.config.autoStart,
        autoEval: state.config.autoEval,
        defaultSpeed: state.config.defaultSpeed,
        postTestRequireConfirm: state.config.postTestRequireConfirm,
        helperUrl: state.config.helperUrl,
        evalAutoUrl: state.config.evalAutoUrl,
      },
    };
  }

  function getChildHelperState() {
    try {
      var w = state.courseTab;
      if (!w || w.closed) return { ok: false, error: 'child_closed' };
      if (!w.__TBH_HELPER__ || !w.__TBH_HELPER__.getState) return { ok: false, error: 'helper_not_ready' };
      return { ok: true, state: w.__TBH_HELPER__.getState() };
    } catch (e) {
      return { ok: false, error: 'child_access_error', message: String(e && e.message ? e.message : e) };
    }
  }

  function getLastChildState() {
    // 通过 BroadcastChannel 收到的最近一次子窗口状态（不要求有 window 引用）
    return lastBroadcast;
  }

  window.__TBH_RUNNER__ = {
    version: state.version,
    configure: configure,
    getState: getState,
    getChildHelperState: getChildHelperState,
    getLastChildState: getLastChildState,
    startCourseByName: startCourseByName,
    nextCourse: nextCourse,
    resolvePostTestConfirm: resolvePostTestConfirm,
    stop: stop,
  };

  emit('ready', { version: state.version });
})();
