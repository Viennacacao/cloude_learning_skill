# Browser-only（Agent 内置浏览器）运行手册

目标：不依赖 Puppeteer / 不额外安装下载浏览器，直接使用 Agent 自带浏览器完成 21tb 课程学习。

约束：同一时间只打开一门课程（串行）。

默认行为：只学习用户指定课程并停下回报；用户在对话中输入“下一门/继续”后才自动推进下一门。

## 对话命令（建议 Agent 遵循）

- `学习 <课程名>`：开始该课程；完成后停下回报
- `下一门` / `继续`：回到课程中心，选择下一门未完成课程并开始学习
- `停止`：停止自动化

## 0. 前置配置（推荐）

- 在项目根目录放置 `.env`（包含 TB_* 与 ZHIPU_* 等配置）。
- Browser-only 注入脚本建议用 https 的脚本地址（GitHub Raw），避免 Mixed Content。

默认（示例，建议使用 tag/commit 固定版本）：

- runner：`https://raw.githubusercontent.com/Viennacacao/cloude_learning_skill/browser-only-v0.1.0/21tb-browser-only-runner.js`
- helper：`https://raw.githubusercontent.com/Viennacacao/cloude_learning_skill/browser-only-v0.1.0/21tb-video-helper.user.js`
- eval：`https://raw.githubusercontent.com/Viennacacao/cloude_learning_skill/browser-only-v0.1.0/scripts/21tb-evaluation-auto.js`

## 1. 登录

打开：`https://v4.21tb.com/login/login.init.do`

若默认显示二维码页，点击 “Password login here” 切换到密码登录。

填写：
- Company ID
- Username
- Password

如弹出 “Continue/Cancel”：点 Continue。

## 2. 进入课程中心（My Courses）

`https://v4.21tb.com/els/html/index.parser.do?id=NEW_COURSE_CENTER&current_app_id=8a80810f5ab29060015ad1906d0b3811#!/els/html/courseCenter/courseCenter.loadStudyTask.do`

点击目标课程卡片进入播放页（通常会新开一个 tab）。

## 3. 在课程播放页注入（进入课程页后再注入）

在课程中心页执行（Agent 的浏览器 evaluate）。Runner 会自动打开课程播放页并注入 helper/eval：

```js
(() => {
  window.__TBH_RUNNER_CONFIG__ = {
    autoStart: true,
    autoStartDelayMs: 1800,
    defaultSpeed: 16,
    autoEval: true,

    postTestEnabled: true,
    postTestRequireConfirm: true, // 需要对话确认
    postTestLowConfidenceThreshold: 0.65,
    postTestAutoSubmitThreshold: 0.7,
    postTestModel: 'glm-4-flash',
    postTestApiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    postTestApiTimeoutMs: 60000,
    // zhipuApiKey 建议由 Agent 从 .env 读取后注入
    zhipuApiKey: '',

    helperUrl: 'https://raw.githubusercontent.com/Viennacacao/cloude_learning_skill/browser-only-v0.1.0/21tb-video-helper.user.js',
    evalAutoUrl: 'https://raw.githubusercontent.com/Viennacacao/cloude_learning_skill/browser-only-v0.1.0/scripts/21tb-evaluation-auto.js',
  };

  const s = document.createElement('script');
  s.src = 'https://raw.githubusercontent.com/Viennacacao/cloude_learning_skill/browser-only-v0.1.0/21tb-browser-only-runner.js';
  s.onload = () => window.__TBH_RUNNER__?.startCourseByName?.('阳明心学——实践的哲学');
  (document.head || document.documentElement).appendChild(s);
})();
```

## 4. 轮询状态（建议每 10~30 秒一次）

```js
window.__TBH_HELPER__?.getState?.()
```

关键字段：
- `state.progress.courseCompleted === true`：课程真正完成
- `state.postTestConfirm.waiting === true`：出现课后测试确认点

## 5. 对话式确认（post-test）

当 `state.postTestConfirm.waiting === true`：

- 用户确认提交：执行
  ```js
  window.__TBH_HELPER__.approvePostTestSubmit()
  ```
- 用户取消：执行
  ```js
  window.__TBH_HELPER__.rejectPostTestSubmit()
  ```

然后继续轮询，直到 `courseCompleted === true`。

## 6. 自动推进下一门（可选）

当课程完成后，如果用户在对话中输入 “下一门/继续”，建议执行：

1. 关闭当前课程 tab（或保留并切换回课程中心 tab）
2. 进入课程中心（My Courses）
3. 在课程列表中选择**下一门未完成课程**（优先匹配 `Progress: Course Learning 0%` 或 `In Progress`，排除 `Currently completed`/`Finish`）
4. 新开课程播放页后重复第 3~5 步
