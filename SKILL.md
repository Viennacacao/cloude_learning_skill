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
- "帮我做课后测试"

## 前置依赖

1. **Node.js** >= 18
2. **Chrome 浏览器**：macOS 上 `/Applications/Google Chrome.app`
3. **npm 依赖**：`cd scripts && npm install`
4. **登录配置**：写入 `.env`；密钥类本地覆盖项建议写入不会提交的 `.env.local`：
   ```
   TB_ENTERPRISE_ID=企业ID
   TB_USER=用户名
   TB_PASS=密码
   ```
5. **课后测试 AI 配置**（OpenAI-compatible 接口，变量名为兼容历史配置而保留）：
   ```
   ZHIPU_API_KEY=你的API密钥
   ZHIPU_API_URL=https://api.deepseek.com/chat/completions
   ZHIPU_MODEL=deepseek-chat
   ```

可先运行 `node scripts/agent.js test-ai` 做连通性和返回格式检查。任何真实密钥都不得写入代码、文档或提交到 Git。

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
| `status` | 获取当前页面状态 | `status` 事件 |
| `screenshot` | 截图保存到运行目录 | `screenshot` 事件 + 路径 |
| `test-ai` | 验证 AI 接口及答案格式 | `ai_test_success` 事件 |
| `run <关键词>` | 完成单门课程（学习→评估→课后测试） | `all_done` / `incomplete` 事件 |
| `run-all` | 一次登录串行完成课表里所有未完成课程 | 每门课的 `all_done` 事件 |
| `dump-test <关键词>` | **只读** dump 课后测试页 DOM + 多选点击试验，不提交 | `dump_test` 事件 |
| `dry-test <关键词>` | **空跑答题**：AI 作答并写入页面后回读校验，**不提交、零消耗** | `dry_run_result` 事件 |

> 注：内部阶段（播放 / 评估 / 测试）已整合到 `run` 命令中，不单独暴露。

> 补考次数有限。**改动答题逻辑后，务必先用 `dry-test` 在全新试卷上验证通过，再跑 `run`。**

## Agent 操作指南

### 用户说"帮我学XX课程"

1. 运行：`node scripts/agent.js run "课程关键词"`
2. 监控 JSON 输出，在每个 `phase` 事件时向用户报告进度
3. 如果某一步失败（`error` 事件），检查状态并尝试修复
4. 最终只有课程中心明确显示已完成时才会输出 `all_done`；否则输出 `incomplete` 并以失败状态退出

### 用户说"看看还有哪些课没学完"

1. 运行：`node scripts/agent.js courses`
2. 解析 JSON 输出，列出未完成课程
3. 询问用户要学哪门

### 异常处理

- **登录失败**：检查 .env 中的凭证是否正确
- **视频不播放**：运行 `status` 检查页面状态；主流程会按目录逐章节重新定位视频
- **评估提交失败**：运行 `screenshot` 截图查看页面，可能按钮文字不同
- **课后测试 AI 失败**：立即停止且禁止提交；检查 API Key、接口地址、模型名及 AI 返回格式，不使用固定选项兜底
- **章节切换失败**：检查 `chapters_detected`、`chapter_switched`、`chapter_switch_confirmed` 和 `chapter_result` 事件定位失败章节
- **多选题没选上 / 得分只有一半**：先用 `dry-test` 空跑。若 `dry_run_result.mismatched` 非空，
  说明选项点击没生效——多半是选项元素结构变了，检查 `clickOption` 的选择器是否还匹配
- **点了没反应、成绩页显示"还有 N 次重测机会"**：这是**已交卷的只读卷**，
  必须先点「去补考」开新卷。脚本已内置 `startRetestIfNeeded`，若它报
  `Retest button not found`，说明按钮文案又变了，把新文案加进正则即可
  （已支持：去补考 / 重测 / 再考 / 重考 / 再测 / 重新测试 / 重新考试）

## 关键设计决策

### 为什么不用浏览器端 helper？

旧方案向浏览器注入了一个 1900 行的 helper 脚本，同时做：
- 播放视频 + 检测评估 + 检测测试 + 自动答题

各检测逻辑互相打架：视频在播放时，helper 看到 `.el-rate` 元素就判定为评估页，导致提前填评估；看到 body 文字含"考试"就判定为测试页。

新方案：**所有决策在 Node.js 完成**。通过 `page.evaluate()` 检查特定元素，根据状态机决定下一步操作。

### 多章节学习

主流程从课程目录对应的 Vue 组件读取 `courseData/resourceDTOS`，按资源顺序执行：

1. 跳过平台已经标记完成的章节
2. 调用课程组件的章节切换方法并确认 `curIndex`
3. 在当前章节和非客服 iframe 中识别视频或文档倒计时
4. 视频按 `--rate` 播放；文档使用当前页面的计时加速 Hook
5. 只有视频结束、倒计时完成或平台 `finish` 标记成立后才进入下一章

章节学习完成后才进入课程评估和课后测试。课程在新标签页打开时，主流程会接管新标签页，避免继续操作旧的课程中心页面。

### AI 课后测试

脚本提取可见题干、题型和选项，调用 AI 生成严格 JSON 答案，再验证：题目数量完整、单选答案属于可见选项、多选答案非空、简答答案非空。AI 调用期间若试卷 iframe 被替换，会重新定位题目并校验试卷指纹；题目变化或答案应用不完整时禁止提交。

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

排除"关闭/取消/返回"类按钮，只找可见、可用且包含"提交/确定"文字的按钮，不使用泛化的 primary 按钮兜底。

## 文件结构

```
cloude_learning_skill/
├── SKILL.md              # 本文件
├── .env                  # 凭证配置
├── .env.local            # 本地 AI 配置（不提交）
├── docs/debug/           # 实跑问题与修复记录
├── scripts/
│   ├── agent.js          # 主入口（所有命令）
│   ├── agent.test.js     # 纯逻辑回归测试
│   ├── package.json      # npm 依赖
│   └── node_modules/     # 依赖
├── runtime-logs/
│   ├── chrome-profile/   # Chrome 会话缓存
│   └── screenshots/      # 运行截图
└── course-data.json      # 课表缓存
```
