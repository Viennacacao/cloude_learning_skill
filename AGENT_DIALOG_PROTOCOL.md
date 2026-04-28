# Agent 对话协议（Browser-only 默认）

本协议面向“云端视频学习”Skill 的 Agent 使用场景：通过对话驱动，使用 Agent 内置浏览器完成课程学习。

## 默认原则

1. **单课串行**：同一时间只打开一门课程播放页。
2. **进入课程页后注入**：必须在 `/courseSetting/courseLearning/play` 页面后再注入 helper/eval。
3. **完成判定**：以 `window.__TBH_HELPER__.getState().progress.courseCompleted === true` 为唯一完成标准。
4. **默认只学指定课程**：完成后停下并回报；用户说“下一门/继续”才推进。

## 用户指令（建议解析）

- `学习 <课程名>`：学习并完成指定课程，然后停下回报
- `下一门` / `继续`：自动推进并学习下一门未完成课程（仍然单课串行）
- `停止`：停止自动化
- `关闭自动评估`：注入时设置 `autoEval: false`
- `自动提交课后测试`：注入时设置 `postTestRequireConfirm: false`

## Agent 输出（建议）

### 开始课程
- 当前课程标题
- 课程页 URL（可选）
- 注入是否成功（是否存在 `window.__TBH_HELPER__`）

### 进度回报
建议每 1~3 分钟回报一次（避免刷屏）：
- `finishedResources/totalResources`
- 当前资源名

### post-test 对话确认
当 `state.postTestConfirm.waiting === true`：
1) Agent 提问：是否提交课后测试？并展示 `state.postTestConfirm.summary`（若存在）
2) 用户回复确认/取消后：
   - confirm → `window.__TBH_HELPER__.approvePostTestSubmit()`
   - cancel → `window.__TBH_HELPER__.rejectPostTestSubmit()`

### 完成回报
当 `courseCompleted === true`：
- 回报“课程已完成”
- 等待用户进一步指令（默认不自动跳转下一门）

