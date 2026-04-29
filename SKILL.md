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
│   ├── 21tb-player-embed.js          # 内嵌播放助手注入器（无插件主链路）+ 配置下发
│   ├── 21tb-evaluation-auto.js       # 课程评估自动完成模块（星级+选择题+论述+提交）
│   ├── 21tb-status-reporter.js       # 结构化状态上报器（JSON 事件流 + 状态快照）
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
POSTTEST_REQUIRE_CONFIRM=true      # 是否要求人工确认提交，默认 true（适合 Agent 自然对话）
```

> **安全提示**：`.env` 文件已加入 `.gitignore`，不会同步到 GitHub。请勿将 API Key 等敏感信息直接写入代码。

## 工作流程

### 默认（推荐）：Puppeteer / 系统浏览器自动化（面向 Agent 自然对话）

> 结论：由于 21tb 播放页在部分内置 WebView 中会出现 `ERR_BLOCKED_BY_ORB` 白屏问题，**优先使用 Puppeteer 驱动系统 Chrome/Chromium** 完成自动化。
>
> 能力：登录 → 抓课表 → 打开播放页 → 注入本地 helper/eval（不依赖 GitHub Raw）→ 自动播放/评估/课后测试 → **对话确认提交** → 完成回报。
>
> 默认行为：只完成用户指定课程并停下回报；用户说“下一门/继续”时再推进下一门未完成课程。

#### 对话命令（面向 Agent）

- `学习 <课程名>`：打开并完成该课程，完成后停下回报
- `下一门` / `继续`：在课程中心中选择“下一门未完成课程”并开始学习
- `停止`：停止自动化（保持当前页面不再操作）

#### 一次性准备

在项目目录执行（安装 Puppeteer 依赖）：

```bash
cd scripts
npm install
```

准备 `.env`（建议放在项目根目录）：
- `TB_ENTERPRISE_ID`
- `TB_USER`
- `TB_PASS`
- 可选：`ZHIPU_API_KEY`（用于 AI 答题）

#### 运行（Agent 模式，结构化输出）

只学指定课程并停下：

```bash
node scripts/21tb-login-crawler.js --agent --json -c "阳明心学——实践的哲学"
```

自动进入第一门未完成课程并学习（但不自动推进下一门）：

```bash
node scripts/21tb-login-crawler.js --agent --json --auto
```

完成后自动推进下一门未完成课程：

```bash
node scripts/21tb-login-crawler.js --agent --json --auto --auto-advance
```

> 稳定性建议：Agent 模式默认会复用 `runtime-logs/chrome-profile` 作为 Chrome profile（减少重复登录、保留缓存）。也可用 `--user-data-dir` 指定。

#### 统一入口（推荐给 Agent / 自然对话）

为“下载即用”场景提供一个更短的入口脚本：`scripts/agent-entry.js`。

```bash
# 学习指定课程（完成后停下）
node scripts/agent-entry.js 学习 "阳明心学——实践的哲学" --headful

# 继续：学习第一门未完成课程（完成后停下）
node scripts/agent-entry.js 继续 --headless

# 全部：自动推进学完全部未完成课程
node scripts/agent-entry.js 全部 --headless

# 课后测试确认（最近一次）
node scripts/agent-entry.js 确认
node scripts/agent-entry.js 取消
```

#### 严格模式（0/0 不完成）

默认启用严格完成判定：
- 当课程页短时间内显示 `0/0`（资源列表未加载/未解析到）时，脚本不会把课程判定为完成，而会持续等待/重试。
- crawler 侧也会要求 `totalResources>0` 才承认完成，避免误判。

#### 调试三连（课程播放页 Console）

当遇到“重复播放 / 不点 Next / 不加速 / 刷新后异常”等问题时，在课程播放页打开 DevTools → Console 执行：

```js
window.__TBH_HELPER__?.version
window.__TBH_HELPER__?._debug?.()
window.__TBH_HELPER__?.getState?.().logs?.slice(-30)
```

说明：
- `version`：确认注入的 helper 是否为最新版本
- `_debug()`：查看是否命中 next/replay 按钮、video ended 状态、Vue 数据是否可读、最近一次动作
- `logs`：查看最近 30 条内部决策日志（是否真的等 3 秒后点击 Next、是否触发兜底等）

#### 对话式确认（post-test）

脚本会在需要确认提交课后测试时输出 `posttest_confirm_required` 事件，并写入“决策文件提示”。  
此时 Agent 在对话中询问用户“确认/取消”，并写入对应 decision 文件后，脚本会继续执行。

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

（已移除旧的分步脚本：统一使用 `21tb-login-crawler.js` 完成登录/抓课/开课/学习。）

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
  - `POSTTEST_REQUIRE_CONFIRM=true`：检测到需要确认时暂停，等待 Agent 对话确认（推荐）
  - `POSTTEST_REQUIRE_CONFIRM=false`：尽量自动提交（更无人值守，但风险更大）
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
2. 或用 `--auto` / `--auto-advance` 完成未完成课程串行推进

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
