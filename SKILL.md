# 云端视频学习 Skill

自动化完成 21tb 时光易学平台的在线课程学习。用户只需提供企业ID、账号、密码，即可一键登录、获取课表、启动课程播放，**视频播完后自动填写并提交课程评估**。

## 触发条件

当用户提到以下内容时使用此 Skill：

- **平台/产品名**："云端视频学习"、"21tb学习"、"时光易学"
- **学习动作**："自动学习"、"刷课"、"课程自动播放"、"开始上课"
- **登录/查询**："登录21tb"、"获取课表"、"启动课程"、"看看还有哪些课没学完"
- **评估相关**："自动完成评估"、"帮我填问卷"、"课程评价"、"Course Evaluation"
- **进度检查**："学完了没"、"查看进度"、"学习状态"

## 前置依赖

1. **Node.js** >= 18
2. **Puppeteer**: `cd scripts && npm install puppeteer`
3. **Tampermonkey（可选）**: `21tb-video-helper.user.js` 作为浏览器侧后备方案

## 文件结构

```
cloud-video-learning/
├── SKILL.md                          # 本文件 — Agent 核心配置
├── README.md                         # 完整文档（按使用场景分章）
├── scripts/
│   ├── 21tb-login-crawler.js         # 主脚本：登录 + 课表 + 打开课程 + 自动播放 + 评估
│   ├── 21tb-course-launcher.js       # 辅助脚本：按名称/编号/ID 启动课程
│   ├── 21tb-player-embed.js          # 内嵌播放助手注入器（无插件主链路）+ 评估集成接口
│   ├── 21tb-evaluation-auto.js       # 课程评估自动完成模块（星级+选择+论述+提交）
│   ├── 21tb-status-reporter.js       # 结构化状态上报器（--json / 进度日志）
│   └── package.json                  # Node.js 依赖配置
├── runtime-logs/                     # 结构化进度日志（自动生成）
├── course-data.json                  # 课表缓存数据（自动生成）
└── 21tb-video-helper.user.js         # 播放助手源码（可被 skill 注入，也可作为油猴后备）
```

## 工作流程

### 模式一：一键全自动（推荐）

```bash
node scripts/21tb-login-crawler.js -e <企业ID> -u <用户名> -p <密码> --auto
```

流程：登录 → 获取课表 → 选择第一个未完成课程 → 注入播放助手自动播放 → 视频播完自动填评估提交

### 模式一补充：按课程名直达

```bash
node scripts/21tb-login-crawler.js -e <企业ID> -u <用户名> -p <密码> -c "课程名"
```

### 模式一补充：自动推进多门课程

```bash
node scripts/21tb-login-crawler.js -e <企业ID> -u <用户名> -p <密码> --auto --auto-advance
```

完成后自动打开下一门，直到全部完成。

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

### 登录流程
1. 打开 `https://v4.21tb.com/login/login.init.do`（默认二维码页）
2. 优先调用页面内置切换（`noErwei()` / `changeWay(1, ...)`）切到账号密码模式
3. 填写：企业ID（`#corpCode`）、用户名（`#loginName`）、密码（`#swInput`）
4. 用 jQuery `val()` + 原生 setter + `input/change/blur` 事件派发混合赋值
5. 点击登录按钮 `.login-btn`，处理"继续登录"确认弹窗
6. 遍历课程中心所有分页，汇总完整课程列表

### 课程中心结构
- URL: `https://v4.21tb.com/els/html/courseCenter/courseCenter.loadStudyTask.do`
- 课程卡片：`.nc-mycourse-card`，链接 `a.goStudy[data-id]`
- 播放页 URL: `https://v4.21tb.com/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId={id}`

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
  "isFinished": false
}
```

### 课程评估（自动完成）
- **触发时机**：某门课程所有视频资源播放完毕后，平台自动跳转到 Course Evaluation 页面
- **检测方式**：轮询检测 `.course-evaluate` 容器是否存在
- **自动执行动作**：
  1. 星级评分 → 5 颗星（`.ant-rate[role=radiogroup]`）
  2. 单选题（通常 4 道）→ 全部选 D（`.ant-radio-wrapper[label="d"]`）
  3. 问答题（1 道）→ 固定填「很不错，高效」（`textarea.ant-input`）
  4. 点击提交（`.course-evaluate-footer .ant-btn-primary`）
  5. 处理提交后弹窗（点击"进入下一步"）
- **默认开启**，可用 `--no-auto-eval` 关闭
- **模块位置**：`scripts/21tb-evaluation-auto.js`，通过 `21tb-player-embed.js` 注入

## Agent 操作指南

### 用户说"帮我登录21tb"
1. 问企业ID、用户名、密码（如未提供）
2. 运行：`node scripts/21tb-login-crawler.js -e {企业ID} -u {用户名} -p {密码}`
3. 等待登录完成和课表获取

### 用户说"帮我启动课程XXX"
1. 优先直接运行（同一会话内完成）：`node scripts/21tb-login-crawler.js -e ... -c "课程名"`
2. 如需复用缓存课表且登录态有效：`node scripts/21tb-course-launcher.js "课程名"`
3. 或用 `--all-unfinished` 启动所有未完成课程

### 用户说"把所有课都学了"
```bash
node scripts/21tb-login-crawler.js -e {企业ID} -u {用户名} -p {密码} --auto --auto-advance --json
```
- 含评估自动完成、自动推进下一门、JSON 结构化输出

### 用户说"检查进度"
1. 读 `runtime-logs/` 下最新 `{sessionId}.state.json`
2. 检查 `currentCourseProgress.courseCompleted` 或事件流中的 `course_complete` / `all_courses_complete`

### 用户说"帮我填问卷/做评估"
- 说明：评估在视频播完后**自动触发**，无需单独操作
- 如需手动触发：导航到评估页后调用 `window.__TBH_EVAL_AUTO__.fillAndSubmit()`

## 注意事项

1. **默认不依赖油猴**：脚本会把播放助手源码直接注入课程页；Tampermonkey 仅作备用
2. **评估默认自动完成**：视频播完跳到评估页时会自动填写提交；用 `--no-auto-eval` 可关闭
3. **浏览器保持打开**：脚本执行后浏览器保持打开，不要手动关闭
4. **登录态有效期**：session 过期需重新运行脚本1
5. **并发建议**：同时打开不超过 3 个课程标签页
6. **倍速设置**：内置播放助手默认 16x，可在控制面板调整
