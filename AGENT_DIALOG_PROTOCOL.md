# Agent 对话协议（Puppeteer / 系统浏览器自动化）

本协议面向“云端视频学习”Skill 的 Agent 使用场景：通过对话驱动，使用 **Puppeteer 驱动系统 Chrome/Chromium** 完成课程学习。

## 默认原则

1. **单课串行**：同一时间只打开一门课程播放页（避免并发导致进度/账号风控异常）。
2. **本地源码注入**：helper/eval 以“源码字符串”注入（`page.evaluateOnNewDocument`），不依赖 GitHub Raw/jsDelivr，跨电脑更稳定。
3. **完成判定**：以 `window.__TBH_HELPER__.getState().progress.courseCompleted === true` 为唯一完成标准。
4. **默认只学指定课程**：完成后停下并回报；用户说“下一门/继续”才推进。
5. **自然对话确认**：遇到课后测试提交时，Agent 用对话询问用户“确认/取消”，并写入 decision 文件后继续执行。

## 用户指令（建议解析）

- `学习 <课程名>`：学习并完成指定课程，然后停下回报
- `下一门` / `继续`：自动推进并学习下一门未完成课程（仍然单课串行）
- `停止`：停止自动化（保持浏览器打开，但不再操作）
- `关闭自动评估`：启动参数使用 `--no-auto-eval`
- `自动提交课后测试`：设置环境变量 `POSTTEST_REQUIRE_CONFIRM=false`（或在启动时覆盖）

## Agent 输出（建议）

### 开始课程
- 当前课程标题
- 当前阶段（launch/login/course_opened/playing）
- 注入是否成功（是否检测到 `window.__TBH_HELPER__`）

### 进度回报
建议每 1~3 分钟回报一次（避免刷屏）：
- `finishedResources/totalResources`
- 当前资源名

### post-test 对话确认（核心：自然语言 → 决策文件）
当脚本输出事件 `posttest_confirm_required`（或 state.phase 进入 `awaiting_posttest_confirm`）：

1) Agent 提问：是否提交课后测试？并展示 `summary`（若存在）
2) 用户回复确认/取消后，Agent 写入 decision 文件（路径由事件或 state 给出）：

**decision 文件内容：**
```json
{ "action": "confirm" }
```
或
```json
{ "action": "cancel" }
```

脚本检测到 decision 文件后，会在页面内调用：
- confirm → `window.__TBH_HELPER__.approvePostTestSubmit()`
- cancel → `window.__TBH_HELPER__.rejectPostTestSubmit()`

### 完成回报
当 `courseCompleted === true`：
- 回报“课程已完成”
- 等待用户进一步指令（默认不自动跳转下一门）
