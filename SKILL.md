---
name: 云端视频学习
description: 自动化完成 21tb「时光易学」平台的在线课程学习：登录→选课→播放视频→课程评估→课后测试，全流程 Node.js 主导、Puppeteer 执行、状态机驱动。
---

# 云端视频学习 Skill

## 架构原则

1. **Node.js 是大脑，Puppeteer 是手** — 所有决策在 Node.js 完成，不注入浏览器端 helper
2. **状态机驱动** — 每一步都有明确的进入/退出条件，不靠关键词猜测
3. **结构化输出** — 每一步输出 JSON 事件，Agent 可监控和交互
4. **交互式** — Agent 可以在任意阶段暂停、检查、询问用户

## 触发条件

当用户提到以下内容时使用此 Skill：
- "21tb学习"、"时光易学"、"云端学习"
- "自动学习"、"刷课"、"课程自动播放"
- "登录21tb"、"获取课表"
- "自动完成评估"、"帮我填问卷"
- "帮我做课后测试"、"AI 答题"

## 前置依赖

1. **Node.js** >= 18
2. **Chrome 浏览器**：macOS 上 `/Applications/Google Chrome.app`
3. **npm 依赖**：`cd scripts && npm install`（puppeteer-core, dotenv）
4. **.env 配置**：
   ```
   TB_ENTERPRISE_ID=企业ID
   TB_USER=用户名
   TB_PASS=密码
   ```

## 工作流程

### 一键全自动模式（推荐）

```bash
node scripts/agent.js run "课程关键词" --rate 16
```

Agent 读取 JSON 输出，监控每个阶段的进度，在异常时可以介入修复。

### 分步模式（交互式）

Agent 可以按需调用单个命令：

| 命令 | 说明 | 输出 |
|------|------|------|
| `login` | 登录 | `login_success` 事件 |
| `courses` | 获取课表 | `courses_fetched` 事件 + 课表 JSON |
| `status` | 获取当前页面状态（截图） | `status` 事件 |
| `screenshot <path>` | 截图保存到指定路径 | 截图路径 |

> 注：内部阶段（播放 / 评估 / 测试）已整合到 `run` 命令中，不单独暴露。

## Agent 操作指南

### 用户说"帮我学XX课程"

1. 运行：`node scripts/agent.js run "课程关键词"`
2. 监控 JSON 输出，在每个 `phase` 事件时向用户报告进度
3. 如果某一步失败（`error` 事件），检查状态并尝试修复
4. 最终 `all_done` 事件表示全部完成

### 用户说"看看还有哪些课没学完"

1. 运行：`node scripts/agent.js courses`
2. 解析 JSON 输出，列出未完成课程
3. 询问用户要学哪门

### 异常处理

- **登录失败**：检查 .env 中的凭证是否正确
- **视频不播放**：运行 `status` 检查页面状态，可能需要 `open` 重新打开课程
- **评估提交失败**：运行 `screenshot` 截图查看页面，可能按钮文字不同
- **课后测试 AI 失败**：脚本会自动用兜底答案（全选D），不影响提交

## 关键设计决策

### 为什么不用浏览器端 helper？

旧方案向浏览器注入了一个 1900 行的 helper 脚本，同时做：
- 播放视频 + 检测评估 + 检测测试 + 自动答题

各检测逻辑互相打架：视频在播放时，helper 看到 `.el-rate` 元素就判定为评估页，导致提前填评估；看到 body 文字含"考试"就判定为测试页。

新方案：**所有决策在 Node.js 完成**。通过 `page.evaluate()` 检查特定元素，根据状态机决定下一步操作。

### 页面状态检测

```
getPageState() 返回：
  pageType: 'video_playing' | 'video_ended' | 'evaluation' | 'posttest' | 'video_idle' | 'unknown'
  hasVideo, videoPlaying, videoEnded
  hasRate, hasTextarea, hasQuestionList
  steps: [步骤列表]
```

判定规则（优先级从高到低）：
1. 有视频正在播放 → `video_playing`
2. 有视频已结束 → `video_ended`
3. 有星级评分 + 文本框 + 无视频 → `evaluation`
4. 有题目列表 → `posttest`
5. 有章节容器或视频元素 → `video_idle`

### 提交按钮查找

排除"关闭/取消/返回"类按钮，只找包含"提交/确定"文字的按钮，或 primary 样式的非关闭按钮。

## 文件结构

```
cloude_learning_skill/
├── SKILL.md              # 本文件
├── .env                  # 凭证配置
├── scripts/
│   ├── agent.js          # 主入口（所有命令）
│   ├── package.json      # npm 依赖
│   └── node_modules/     # 依赖
├── runtime-logs/
│   ├── chrome-profile/   # Chrome 会话缓存
│   └── screenshots/      # 运行截图
└── course-data.json      # 课表缓存
```
