---
name: 云端视频学习
description: 自动化完成 21tb「时光易学」平台的在线课程学习：一键登录、获取课表、自动播放；视频结束后自动提交课程评估，并可选用智谱 AI 自动完成课后测试。
---

# 云端视频学习 Skill

自动化完成 21tb 时光易学平台的在线课程学习。用户只需提供企业ID、账号、密码，即可一键登录、获取课表、启动课程播放，**视频播完后自动填写并提交课程评估，课后测试通过 AI 自动答题**。

## 触发条件

当用户提到以下内容时使用此 Skill：

- **平台/产品名**："云端视频学习"、"21tb学习"、"时光易学"
- **学习动作**："自动学习"、"刷课"、"课程自动播放"、"开始上课"
- **登录/查询**："登录21tb"、"获取课表"、"启动课程"、"看看还有哪些课没学完"
- **评估相关**："自动完成评估"、"帮我填问卷"、"课程评价"、"Course Evaluation"
- **课后测试相关**："帮我做课后测试"、"自动答题"、"AI 答题"
- **进度检查**："学完了没"、"查看进度"、"学习状态"

## 前置依赖

1. **Node.js** >= 18
2. **浏览器依赖**：运行 `cd scripts && npm install` 安装 puppeteer 及相关依赖
3. **Tampermonkey（可选）**：`21tb-video-helper.user.js` 作为浏览器侧后备方案
4. **智谱 AI API Key（可选）**：用于课后测试 AI 自动答题，配置在 `.env` 文件中

## 文件结构

```
cloud-video-learning/
├── SKILL.md                          # 本文件 — Agent 核心配置
├── README.md                         # 完整文档
├── .env                              # 环境变量配置（不上传，含 API Key）
├── .gitignore                        # 忽略 .env、runtime-logs、node_modules
├── scripts/
│   ├── 21tb-login-crawler.js         # 主脚本：登录 + 课表 + 打开课程 + 自动播放 + 评估/测试
│   ├── 21tb-course-launcher.js      # 辅助脚本：按名称/编号/ID 启动课程
│   ├── 21tb-player-embed.js          # 内嵌播放助手注入器（无插件主链路）+ 配置下发
│   ├── 21tb-evaluation-auto.js       # 课程评估自动完成模块（星级+选择题+论述+提交）
│   ├── 21tb-status-reporter.js       # 结构化状态上报器（JSON 事件流 + 状态快照）
│   ├── test-ai-solve.js              # AI 答题接口调试工具
│   └── package.json                  # Node.js 依赖配置
├── runtime-logs/                     # 结构化进度日志（自动生成，不上传）
├── course-data.json                  # 课表缓存数据（自动生成，不上传）
└── 21tb-video-helper.user.js         # 播放助手源码（注入课程页，也可用作油猴脚本）
```

## 环境变量配置

首次使用前，在项目根目录创建 `.env` 文件，内容示例：

```bash
# 必填：21tb 登录凭证
TB_ENTERPRISE_ID=你的企业ID
TB_USER=你的用户名
TB_PASS=你的密码

# 选填：智谱 AI（用于课后测试自动答题）
# 从 https://open.bigmodel.cn/ 获取 API Key
ZHIPU_API_KEY=your_key_here
ZHIPU_MODEL=glm-4-flash
ZHIPU_API_BASE_URL=https://open.bigmodel.cn/api/paas/v4/chat/completions

# 选填：答题行为配置
POSTTEST_AI_TIMEOUT_MS=60000       # AI 单批请求超时（毫秒），默认 60000
POSTTEST_REQUIRE_CONFIRM=false      # 是否要求人工确认提交，默认 false（自动提交）
```

> **安全提示**：`.env` 文件已加入 `.gitignore`，不会同步到 GitHub。请勿将 API Key 等敏感信息直接写入代码。

## 工作流程

### 默认（推荐）：Agent 内置浏览器 Browser-only 串行学习

> 目标：**不依赖 Puppeteer、不下载/安装额外浏览器**，直接使用 Agent 软件自带浏览器完成：
> 登录 → 进入课程 → **进入课程页后注入** → 自动播放/评估/课后测试 → 对话确认提交 → 完成。
>
> 约束：**同一时间只打开一门课**（串行）。
>
> 默认行为：**只完成用户指定的课程并停下回报**。如用户在对话中输入“下一门/继续”，再自动推进到下一门未完成课程（仍然单课串行）。

#### 对话命令（面向 Agent）

- `学习 <课程名>`：打开并完成该课程，完成后停下回报
- `下一门` / `继续`：在课程中心中选择“下一门未完成课程”并开始学习
- `停止`：停止自动化（保持当前页面不再操作）

#### Step 0：准备可被 https 页面加载的脚本地址（避免 Mixed Content）

由于课程页是 `https://`，浏览器会阻止从 `http://127.0.0.1` 加载脚本（Mixed Content）。
因此 **Browser-only 默认使用 https 资源地址**（推荐放在 GitHub Raw / 你自己的 https 静态站点）。

推荐（GitHub Raw 示例，固定 tag/commit）：
- Runner：`https://raw.githubusercontent.com/Viennacacao/cloude_learning_skill/browser-only-v0.1.0/21tb-browser-only-runner.js`
- 播放助手：`https://raw.githubusercontent.com/Viennacacao/cloude_learning_skill/browser-only-v0.1.0/21tb-video-helper.user.js`
- 评估模块：`https://raw.githubusercontent.com/Viennacacao/cloude_learning_skill/browser-only-v0.1.0/scripts/21tb-evaluation-auto.js`

> 稳定性建议：生产使用时建议把 `main` 替换为 **tag/commit hash**，避免脚本更新导致行为变化。

> 本仓库内的 `scripts/21tb-asset-server.js` 可作为“本地调试/非 https 页面/自建 https 代理”时的资源服务，但不作为默认方案。

#### Step 1：用 Agent 内置浏览器登录

1. 打开登录页：`https://v4.21tb.com/login/login.init.do`
2. 切换到密码登录（若默认是二维码）：点击 “Password login here”
3. 填写：Company ID / Username / Password
4. 若出现 “Continue/Cancel” 弹窗：点 Continue

> 也支持自动登录：Runner 可在登录页读取 `__TBH_RUNNER_CONFIG__` 里的 `enterpriseId/username/password` 自动填表并提交。  
> 推荐由 Agent 从本地 `.env` 读取后再注入（若缺失会提示用户输入）。

#### Step 2：进入课程中心并打开指定课程

课程中心（My Courses）：  
`https://v4.21tb.com/els/html/index.parser.do?id=NEW_COURSE_CENTER&current_app_id=8a80810f5ab29060015ad1906d0b3811#!/els/html/courseCenter/courseCenter.loadStudyTask.do`

打开课程后进入播放页（URL 通常包含）：`/courseSetting/courseLearning/play?...courseId=...`

#### Step 3：进入课程页后注入 helper/eval（Browser-only）

在课程中心页（My Courses）执行以下逻辑（通过 Agent 的浏览器 evaluate 注入）。Runner 会自动打开课程播放页，并在播放页内注入 helper/eval：

```js
(() => {
  window.__TBH_RUNNER_CONFIG__ = {
    // 登录（可选；用于自动登录）
    enterpriseId: '<TB_ENTERPRISE_ID>',
    username: '<TB_USER>',
    password: '<TB_PASS>',

    // helper 行为
    autoStart: true,
    autoStartDelayMs: 1800,
    defaultSpeed: 16,
    autoEval: true,

    // 课后测试
    postTestEnabled: true,
    postTestRequireConfirm: true, // 若希望自动提交则设 false
    postTestModel: 'glm-4-flash',
    postTestApiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    postTestApiTimeoutMs: 60000,
    zhipuApiKey: '<ZHIPU_API_KEY>',

    // 资源（需 https）
    helperUrl: 'https://raw.githubusercontent.com/Viennacacao/cloude_learning_skill/browser-only-v0.1.0/21tb-video-helper.user.js',
    evalAutoUrl: 'https://raw.githubusercontent.com/Viennacacao/cloude_learning_skill/browser-only-v0.1.0/scripts/21tb-evaluation-auto.js',
  };

  const s = document.createElement('script');
  s.src = 'https://raw.githubusercontent.com/Viennacacao/cloude_learning_skill/browser-only-v0.1.0/21tb-browser-only-runner.js';
  s.onload = () => window.__TBH_RUNNER__?.startCourseByName?.('阳明心学——实践的哲学');
  (document.head || document.documentElement).appendChild(s);
})();
```

> 重要：上述 tag/commit 必须已推送到 GitHub 远端；若你尚未 push/tag，请先 push/tag，或临时把 URL 改为 `main`。

> 安全提示：`zhipuApiKey` 建议由 Agent 从本地 `.env` 读取后再注入，避免写死在提示词/文档里。

#### Step 4：轮询状态并对话式确认提交

反复读取：
- `window.__TBH_HELPER__.getState().progress.courseCompleted`（true 表示课程真正完成）
- `window.__TBH_HELPER__.getState().postTestConfirm.waiting`

当出现 `postTestConfirm.waiting === true`：
- Agent 在对话中询问用户“是否提交课后测试？”
- 用户确认：执行 `window.__TBH_HELPER__.approvePostTestSubmit()`
- 用户取消：执行 `window.__TBH_HELPER__.rejectPostTestSubmit()`

当出现 `courseCompleted === true`：
- Agent 回报“指定课程已完成”
- 等待用户下一条对话指令（默认不自动跳转下一门；除非用户说“下一门/继续”）

### 后备方案（可选）：Puppeteer 脚本一键全自动

> 仅当你不使用 Agent 内置浏览器，或需要纯命令行无人值守运行时使用。  
> 注意：此方案通常需要可用的 Chrome/Chromium（可能触发下载/安装）。

#### 一键全自动

```bash
node scripts/21tb-login-crawler.js -e <企业ID> -u <用户名> -p <密码> --auto
```

流程：登录 → 获取课表 → 选择第一个未完成课程 → 注入播放助手自动播放 → 视频播完自动填评估提交 → 自动检测并完成课后测试

#### Agent 对话式（Puppeteer 后备）：单页串行 + 自动退出

```bash
node scripts/21tb-login-crawler.js --agent --auto --auto-advance --json
```

### 模式一补充：按课程名直达

```bash
node scripts/21tb-login-crawler.js -e <企业ID> -u <用户名> -p <密码> -c "课程名"
```

### 模式一补充：自动推进多门课程

```bash
node scripts/21tb-login-crawler.js -e <企业ID> -u <用户名> -p <密码> --auto --auto-advance
```

完成后自动打开下一门，直到全部完成（含课后测试的课程也会尝试 AI 答题）。

### 模式一补充：禁用自动评估

```bash
node scripts/21tb-login-crawler.js -e <企业ID> -u <用户名> -p <密码> --auto --no-auto-eval
```

### 模式二：分步操作

```bash
# 步骤1：登录并获取课表
node scripts/21tb-login-crawler.js -e <企业ID> -u <用户名> -p <密码>

# 步骤2：启动指定课程（需要已有有效登录态或缓存课表）
node scripts/21tb-course-launcher.js "项目成本管理"
node scripts/21tb-course-launcher.js --all-unfinished
node scripts/21tb-course-launcher.js --interactive
```

## 关键信息

### 平台信息

- 平台地址：`https://v4.21tb.com/`
- 技术栈：Vue 2 + jQuery + 阿里云播放器 + Ant Design 组件库
- 登录页：`/login/login.init.do`（默认二维码）
- 课程中心：`/els/html/courseCenter/courseCenter.loadStudyTask.do`
- 播放页模板：`/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId={id}`

### 登录流程

1. 打开登录页 `https://v4.21tb.com/login/login.init.do`（默认二维码页）
2. 优先调用页面内置切换函数（`noErwei()` / `changeWay(1, ...)`）切到账号密码模式
3. 填写：企业ID（`#corpCode`）、用户名（`#loginName`）、密码（`#swInput`）
4. 用 jQuery `val()` + 原生 setter + `input/change/blur` 事件派发混合赋值
5. 点击登录按钮 `.login-btn`，处理"继续登录"确认弹窗
6. 遍历课程中心所有分页，汇总完整课程列表

### 课程数据结构

```json
{
  "index": 1,
  "id": "5cd292907af72b6882f516ad35972b71",
  "title": "文案写作的2W1H模型",
  "graduation": "Post-test",
  "progress": "Course Assessment",
  "progressPercent": "",
  "courseType": "Optional",
  "isFinished": false,
  "isCompletable": true
}
```

### 课程评估（自动完成）

- **触发时机**：某门课程所有视频资源播放完毕后，平台自动跳转到 Course Evaluation 页面
- **检测方式**：轮询检测 `.course-evaluate` 容器是否存在（同时检测主文档和同域 iframe）
- **自动执行动作**：
  1. 星级评分 → 5 颗星（`.ant-rate[role=radiogroup]`）
  2. 单选题（通常 4 道）→ 全部选 D（`.ant-radio-wrapper` 匹配 label 为 D 的项）
  3. 问答题（1 道）→ 固定填「很不错，高效」（`textarea.ant-input`）
  4. 点击提交（`.course-evaluate-footer .ant-btn-primary`）
  5. 处理提交后弹窗（点击"进入下一步"）
- **默认开启**，可用 `--no-auto-eval` 关闭
- **模块位置**：`scripts/21tb-evaluation-auto.js`，通过 `21tb-player-embed.js` 注入

### 课后测试（AI 自动答题）

- **触发时机**：课程所有视频播放完成后，平台跳转到课后测试（Post-test）页面
- **检测方式**：轮询检测 `.course-test-wrap` / `.course-test-type-list-item` 元素（同时检测主文档和同域 iframe）
- **识别关键词**："课后测试"、"post-test"、"post test"、"考试"、"测验"
- **答题策略**（三层兜底）：
  1. **本地题库**：优先在 `localStorage` 中查找历史答题记录（命中则跳过 AI）
  2. **AI 解答**：未命中题库时，分批调用智谱 AI（默认每批 10 题），AI 返回答案、置信度、理由
  3. **规则兜底**：AI 调用失败时，使用默认选项（D 或末选项）
- **题目提取规则**：
  - 只提取顶级 `.course-test-type-list-item` 容器（过滤嵌套的选项元素）
  - 每道题至少需要有 2 个选项才视为有效题目
  - 支持单选、多选、判断题自动识别
- **提交策略**：
  - 平均置信度 >= 70% 且无低置信度题时：**自动提交**
  - 平均置信度 < 70% 或存在低置信度题时：**等待人工确认**（`POSTTEST_REQUIRE_CONFIRM=false` 时自动提交）
- **题库自学习**：答题后将新学到的答案存入 `localStorage`，下次遇到相同题目直接命中

### 播放助手（浏览器侧核心逻辑）

- **注入方式**：脚本通过 `page.evaluate()` 将源码注入课程播放页，无需油猴
- **暴露 API**：`window.__TBH_HELPER__`
  - `.getState()` — 获取当前播放进度状态
  - `.startAutoPlay()` — 启动自动播放
  - `.stopAutoPlay()` — 停止自动播放
  - `.getPostTestProgress()` — 获取课后测试答题进度
- **控制面板**：页面右下角浮窗，显示实时进度、倍速调节（1x~16x）、手动操作按钮
- **评估接口**：`window.__TBH_EVAL_AUTO__.fillAndSubmit()` 可手动触发评估填写

### 状态上报机制

- **结构化日志**：`runtime-logs/{sessionId}.events.jsonl`（每行一个 JSON 事件）
- **状态快照**：`runtime-logs/{sessionId}.state.json`（最新状态，可轮询）
- **主要事件类型**：

| 事件类型 | 含义 |
|---------|------|
| `run_initialized` | 脚本启动 |
| `login_success` | 登录成功 |
| `course_list_saved` | 课表保存完成 |
| `course_opened` | 课程页已打开 |
| `course_progress` | 播放进度更新 |
| `eval_complete` | 课程评估已完成提交 |
| `posttest_complete` | 课后测试已完成提交 |
| `posttest_confirm_required` | 课后测试需要人工确认提交（当开启确认模式且置信度不足时） |
| `posttest_confirm_resolved` | 已收到人工决策并执行（confirm/cancel） |
| `course_complete` | 某门课程全部完成 |
| `all_courses_complete` | 全部课程完成 |
| `error` | 错误 |

## Agent 操作指南

### 用户说"帮我登录21tb"

1. 询问企业ID、用户名、密码（如未提供）
2. 检查或提示用户创建 `.env` 文件配置登录凭证
3. 运行：`node scripts/21tb-login-crawler.js -e {企业ID} -u {用户名} -p {密码}`
4. 等待登录完成和课表获取

### 用户说"帮我启动课程XXX"

1. 优先直接运行（同一会话内完成）：`node scripts/21tb-login-crawler.js -e ... -c "课程名"`
2. 如需复用缓存课表且登录态有效：`node scripts/21tb-course-launcher.js "课程名"`
3. 或用 `--all-unfinished` 启动所有未完成课程

### 用户说"把所有课都学了"

```bash
node scripts/21tb-login-crawler.js -e {企业ID} -u {用户名} -p {密码} --auto --auto-advance
```
- 含评估自动完成、AI 课后测试答题、自动推进下一门、JSON 结构化输出

### 用户说"检查进度"

1. 读 `runtime-logs/` 下最新 `{sessionId}.state.json`
2. 检查 `currentCourseProgress.courseCompleted` 或事件流中的 `course_complete` / `posttest_complete`

### 用户说"帮我填问卷/做评估"

- 说明：评估在视频播完后**自动触发**，无需单独操作
- 如需手动触发：导航到评估页后调用 `window.__TBH_EVAL_AUTO__.fillAndSubmit()`

### 用户说"AI 答题不管用"或"想手动答题"

- 检查 `.env` 中是否配置了 `ZHIPU_API_KEY`
- 可运行 `node scripts/test-ai-solve.js` 测试 AI 接口是否正常
- 确认智谱 API Key 余额充足

## 注意事项

1. **默认不依赖油猴**：脚本会把播放助手源码直接注入课程页；Tampermonkey 仅作备用
2. **评估默认自动完成**：视频播完跳到评估页时会自动填写提交；用 `--no-auto-eval` 可关闭
3. **课后测试默认尝试 AI 答题**：即使未配置 API Key，脚本也会使用规则兜底（选 D）尝试完成
4. **浏览器保持打开**：脚本执行后浏览器保持打开，不要手动关闭
5. **登录态有效期**：session 过期需重新运行脚本
6. **Agent 模式默认单课串行**：同一时间只学习一门课程（更稳定，也更符合对话式工作流）
7. **倍速设置**：内置播放助手默认 16x，可在控制面板调整
8. **.env 安全**：所有敏感信息（账号密码、API Key）必须放在 `.env` 文件中，永不提交到 GitHub
