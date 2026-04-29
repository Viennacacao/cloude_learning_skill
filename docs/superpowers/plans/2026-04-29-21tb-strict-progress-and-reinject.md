# 21tb 严格进度判定 & 刷新后自动重注入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复“0/0 误判完成、未能自动 16x 播放、页面刷新后注入丢失”三类问题，使 Skill 在 Puppeteer/系统浏览器自动化路径下稳定工作，并保持自然对话驱动的课后测试确认闭环。

**Architecture:**  
1) 在 helper 内引入“严格进度门槛（must see resources）”与“自动播放/倍速持续重试”；  
2) 在 crawler 侧引入第二道完成判定门槛（totalResources>0）；  
3) 注入策略从“仅注入当前页”升级为“evaluateOnNewDocument 持续注入 + 当前页兜底注入”，保证刷新/跳转后仍生效。

**Tech Stack:** Node.js, Puppeteer, injected JS (helper/eval), JSONL event stream.

---

## Files to touch (locked)

**Modify:**
- `scripts/21tb-player-embed.js`：启用 `prepareEmbeddedPlayer()` 常驻注入；补一个 `ensureEmbeddedPlayerInjected()` 小工具（新 document + 当前页兜底）
- `scripts/21tb-login-crawler.js`：开课时使用常驻注入；完成判定加“totalResources>0”门槛；在关键点输出更明确的事件/日志
- `21tb-video-helper.user.js`：严格进度逻辑（hasSeenResources）；0/0 不可判定完成；自动播放与 16x 倍速重试；刷新/重载后自恢复

**Docs:**
- `README.md`：补充“严格模式解释、刷新恢复说明”
- `SKILL.md`：补充“严格模式默认行为（0/0 不完成）”

---

## Task 1: 注入策略升级为“常驻注入 + 当前页兜底”

**Files:**
- Modify: `scripts/21tb-login-crawler.js`
- Modify: `scripts/21tb-player-embed.js`

- [ ] **Step 1: 在 `scripts/21tb-player-embed.js` 添加工具函数**

新增函数（示例签名）：

```js
async function ensureEmbeddedPlayerInjected(page, config) {
  // 1) 先设置 evaluateOnNewDocument（保证刷新/跳转后仍注入）
  await prepareEmbeddedPlayer(page, config);
  // 2) 对当前已加载页面兜底注入一次
  await injectEmbeddedPlayerIntoCurrentPage(page, config);
}
```

- [ ] **Step 2: 在 `scripts/21tb-login-crawler.js` 的开课流程里使用常驻注入**

在 `openCourseWithEmbeddedPlayer()` 中：
1) `page.goto(courseUrl, ...)` 前后都调用 `ensureEmbeddedPlayerInjected(page, ...)`（建议：goto 前先 prepare，goto 后 inject current）
2) `waitForEmbeddedPlayer()` 仍保留，用于确认注入是否成功

预期：用户手动刷新页面后，helper 会自动再次注入，UI/状态不丢。

- [ ] **Step 3: 冒烟验证**

Run（Mac/Windows 环境）：
```bash
node scripts/agent-entry.js 学习 "阳明心学——实践的哲学" --headful
```

操作：在课程页手动刷新一次；观察控制台/页面右下角浮窗是否仍存在、进度是否继续更新。

- [ ] **Step 4: Commit**

```bash
git add scripts/21tb-player-embed.js scripts/21tb-login-crawler.js
git commit -m "fix(puppeteer): reinject helper on refresh via evaluateOnNewDocument"
```

---

## Task 2: 严格完成判定（0/0 不可完成）+ crawler 二次门槛

**Files:**
- Modify: `21tb-video-helper.user.js`
- Modify: `scripts/21tb-login-crawler.js`

- [ ] **Step 1: helper 内引入 hasSeenResources 状态**

在 helper 的运行态加入：
- `hasSeenResources: boolean`（初始 false）
- 当 `resources.length > 0` 时置 true，并更新 `playProgress.totalResources/finishedResources`
- 当 `resources.length === 0`：
  - **不得**进入“所有资源已完成”的逻辑
  - `playProgress.courseCompleted` 必须保持 false
  - UI 日志提示“资源未加载/解析失败，正在重试…”

- [ ] **Step 2: helper 的 courseCompleted 计算加严格门槛**

将现有：
```js
playProgress.courseCompleted = (freshResources.length > 0 && freshFinished === freshResources.length && !isPostTestPage() && !isCourseEvaluatePage());
```

升级为：
- 必须 `hasSeenResources === true`
- 且 `freshResources.length > 0`
- 且 `freshFinished === freshResources.length`
- 且不在评估/测试页（保持原逻辑）

- [ ] **Step 3: crawler 的完成判定增加二次门槛**

在 `waitForCourseCompletion()` 中，当检测到：
```js
if (p.courseCompleted) return true;
```

改为：
```js
if (p.courseCompleted && p.totalResources > 0) return true;
```

并在 `p.totalResources === 0 && p.courseCompleted === true` 时输出 warning（说明 helper/页面异常，避免误判）。

- [ ] **Step 4: Commit**

```bash
git add 21tb-video-helper.user.js scripts/21tb-login-crawler.js
git commit -m "fix(progress): prevent 0/0 from being treated as completed"
```

---

## Task 3: 自动播放与 16x 倍速“持续重试直到成功”

**Files:**
- Modify: `21tb-video-helper.user.js`

- [ ] **Step 1: 将 `applySpeed()` 升级为带重试的 ensureSpeed()**

目标：播放器晚出现/异步挂载时也能最终设为 16x。

建议实现：
- 每 1s 尝试一次，共 60 次（60s）
- 同时尝试：
  - `<video>.playbackRate = currentSpeed`
  - AliPlayer setSpeed / setPlayerOptions

- [ ] **Step 2: 自动播放 ensurePlaying()**

在 startAutoPlay 进入课程页后：
- 若检测到 video 存在但 paused，则调用 `video.play()`（捕获 promise 拒绝）
- 若被 autoplay policy 拦截，则 UI 提示“需要点一次播放按钮解锁”

- [ ] **Step 3: 资源/组件未就绪时的重试策略**

当 `getCoursePlayComponent()` 或 `getCourseData()` 为空时：
- 不进入完成
- 进入“等待课程组件/数据就绪”循环（例如每 2s 检查一次，最多 2 分钟）
- 就绪后再进入资源列表/播放流程

- [ ] **Step 4: Commit**

```bash
git add 21tb-video-helper.user.js
git commit -m "fix(playback): retry to start and enforce 16x speed until player ready"
```

---

## Task 4: 文档同步

**Files:**
- Modify: `README.md`
- Modify: `SKILL.md`

- [ ] **Step 1: README 增加“严格模式”说明**
- [ ] **Step 2: README 增加“刷新后自动恢复”说明**
- [ ] **Step 3: SKILL.md 同步默认行为（0/0 不完成、重试、对话确认）**
- [ ] **Step 4: Commit**

```bash
git add README.md SKILL.md
git commit -m "docs: document strict progress gating and reinjection behavior"
```

---

## Plan self-review checklist

- [ ] 覆盖了 3 个问题：误判完成、未 16x 自动播放、刷新后注入丢失
- [ ] 没有 “TODO/TBD” 占位
- [ ] 所有改动文件路径明确
- [ ] 每个 Task 都有可验证步骤

