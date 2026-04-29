# 21tb 分片推进策略（混合）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复“循环播放同一片段 + 未按 3 秒延迟点下一节 + 未自动跳过已完成片段”，让课程分片推进符合平台完成标识触发逻辑且稳定推进。

**Architecture:** 在 helper 侧实现“混合推进策略”：已完成片段直接组件切换跳过；未完成片段等待结束→延迟 3 秒→点击下一节按钮触发完成；增加卡死检测兜底。核心判定抽成可测试的纯函数模块。

**Tech Stack:** Node.js（node:test）, injected JS helper（21tb-video-helper.user.js）, Puppeteer.

---

## File map

**Create**
- `scripts/21tb-advance-strategy.js`：纯函数，输入当前资源状态/按钮状态/卡死计数，输出下一步动作（delayMs/方式）
- `scripts/tests/advance-strategy.test.js`：TDD 单测

**Modify**
- `21tb-video-helper.user.js`：在 `playLoop / waitForNextButton / skipFinishedSections` 落地混合策略 + 3 秒延迟 + 卡死检测

---

### Task 1: 先写“混合推进策略”纯函数与测试（TDD）

**Files:**
- Create: `scripts/tests/advance-strategy.test.js`
- Create: `scripts/21tb-advance-strategy.js`

- [ ] **Step 1: Write failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { decideAdvanceAction } = require('../21tb-advance-strategy');

test('finish=true => immediate component jump', () => {
  assert.deepEqual(
    decideAdvanceAction({ currentFinished: true, stuckCount: 0, nextButtonVisible: true }),
    { type: 'jump', via: 'component', delayMs: 0 }
  );
});

test('finish=false + ended => delay 3000 then click next', () => {
  assert.deepEqual(
    decideAdvanceAction({ currentFinished: false, videoEnded: true, stuckCount: 0, nextButtonVisible: true }),
    { type: 'next', via: 'button', delayMs: 3000 }
  );
});
```

- [ ] **Step 2: Verify RED**

Run:
```bash
cd scripts
node --test tests/advance-strategy.test.js
```
Expected: FAIL (module not found)

- [ ] **Step 3: Minimal implementation**

实现 `decideAdvanceAction(input)`：
- 若 `currentFinished===true` → `{type:'jump', via:'component', delayMs:0}`
- 否则若 `videoEnded===true && nextButtonVisible===true` → `{type:'next', via:'button', delayMs:3000}`
- 否则 → `{type:'wait', via:'none', delayMs:0}`

- [ ] **Step 4: Verify GREEN**

同 Step2，Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/21tb-advance-strategy.js scripts/tests/advance-strategy.test.js
git commit -m "test+feat: add mixed slice advance decision helper"
```

---

### Task 2: 在 helper 中接入混合策略（3 秒延迟 + 跳过已完成）

**Files:**
- Modify: `21tb-video-helper.user.js`

- [ ] **Step 1: 将 3 秒延迟固化为配置项**

新增/调整配置项：
- `ADVANCE_DELAY_AFTER_ENDED_MS = 3000`

- [ ] **Step 2: playLoop 每轮先读取当前资源 finish**

每轮计算：
- `current = freshResources[curIdx]`
- 如果 `current.finish === true`：
  - 直接寻找 `nextUnfinished`
  - 优先组件切换（`playNextSection/checkoutSection`）
  - 不等待 3 秒

- [ ] **Step 3: 未完成片段：等待 ended / next 按钮 → 延迟 3 秒 → 点下一节**

当 `waitForNextButton()` 返回 `next` 或 `video.ended===true`：
- `await sleep(3000)`
- `clickNextButton()`（失败再组件切换兜底）

- [ ] **Step 4: 卡死检测**

维护：
- `lastResourceKey`（resourceId 或 resourceName）
- `stuckCount`（连续重复次数）

若 `stuckCount >= 5`：
- `finish=true` → 强制组件切换到下一节
- `finish=false` → 按“ended→3 秒→点下一节”走兜底
- 最后兜底：`window.location.reload()`

- [ ] **Step 5: 验证（手动）**

Run:
```bash
node scripts/agent-entry.js 学习 "阳明心学——实践的哲学" --headful
```

观察：
- 已完成节：日志出现“立即跳过”
- 未完成节：日志出现“等待 3 秒后点下一节”
- 不再循环播放同一片段

- [ ] **Step 6: Commit**

```bash
git add 21tb-video-helper.user.js
git commit -m "fix(helper): mixed advance strategy with 3s delay and skip completed"
```

