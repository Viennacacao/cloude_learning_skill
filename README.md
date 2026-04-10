# 云端视频学习 — 完整文档

自动化完成 **21tb 时光易学** 平台的在线课程学习：登录 → 获取课表 → 自动播放视频 → **自动填写并提交课程评估**，全程无需人工干预。

---

## 📖 目录

- [🚀 场景一：我是普通用户（小白上手）](#-场景一我是普通用户小白上手)
- [🤖 场景二：通过 AI Agent 使用](#-场景二通过-ai-agent-使用)
- [⌨️ 场景三：开发者 / 命令行用户](#-场景三开发者--命令行用户)
- [🔧 技术细节](#-技术细节)
- [❓ 常见问题](#-常见问题)

---

## 🚀 场景一：我是普通用户（小白上手）

### 我需要准备什么？

1. 一台能联网的电脑（Mac / Windows / Linux 都行）
2. 安装 Node.js（[nodejs.org](https://nodejs.org)，版本 >= 18）
3. 你的 21tb 企业ID、账号、密码

### 第一步：安装

```bash
# 1. 克隆（或下载）本 Skill 到本地
git clone git@github.com:Viennacacao/Cloudlearning-assistant-skill.git

# 2. 安装浏览器依赖
cd cloud-video-learning/scripts
npm install puppeteer
```

> 不需要安装浏览器插件！脚本会自动把播放助手注入到页面里。

### 第二步：开始使用

最简单的用法 — 一行命令搞定一切：

```bash
cd scripts
node 21tb-login-crawler.js -e 你的企业ID -u 用户名 -p 密码 --auto
```

这行命令做了什么？

```
① 打开浏览器 → 登录平台
② 获取你的全部课程列表
③ 自动打开第一门未完成的课程
④ 以 16 倍速自动播放所有视频
⑤ 视频播完后 → 自动填写评估问卷 → 提交 ✅
```

**其他常用命令：**

| 我想做... | 命令 |
|----------|------|
| 学完某一门指定课程 | `node 21tb-login-crawler.js -e ... -c "创新方法"` |
| 把所有未完成课程全部学完 | `node 21tb-login-crawler.js -e ... --auto --auto-advance` |
| 只登录看看有哪些课 | `node 21tb-login-crawler.js -e ...` |
| 不想自动填评估问卷 | 加上 `--no-auto-eval` |

### 运行中我需要注意什么？

- **浏览器不要关** — 脚本运行期间会保持浏览器打开
- **可以同时开多门课** — 但建议不超过 3 个
- **学完了怎么看？** — 脚本会在终端输出进度信息；也可以查看 `runtime-logs/` 目录下的日志文件

---

## 🤖 场景二：通过 AI Agent 使用

如果你在用 WorkBuddy 或其他 AI Agent 平台，导入此 Skill 后直接用自然语言对话即可。

### 怎么导入 Skill？

1. 将本仓库克隆到本地
2. 在 Agent 平台中选「从目录导入」，选择 `Cloudlearning-assistant-skill` 目录
3. 导入后即可在任意对话中激活

### 能说什么话来触发它？

| 你说的话 | Agent 会做的事 |
|---------|--------------|
| 「帮我登录 21tb」 | 自动登录并获取课表 |
| 「帮我刷课 / 自动学习」 | 登录 + 启动第一门未完成课程的自动播放 |
| 「看看还有哪些课没学完」 | 展示未完成课程列表及进度 |
| 「帮我把《创新方法》学了」 | 按课程名直达并自动播放 |
| 「把所有课全部学完」 | `--auto --auto-advance` 连续学完全部课程 |
| 「帮我填一下课程问卷 / 评估」 | 说明：评估在视频播完后自动完成 |
| 「检查一下学习进度了没」 | 读取日志中的状态快照 |

### 典型对话示例

```
你：帮我登录 21tb 时光易学，看看还有哪些课没学完

Agent：
  ✅ 正在登录 21tb 时光易学平台...
  ✅ 登录成功！企业：lscb  用户：006627
  ✅ 已获取完整课表（共 54 门课程）

  📋 未完成课程列表（14 门）：
     1. 创新方法：组合创新与交叉创新        🔄 进行中
     2. 项目成本管理                        67%
     3. 项目沟通管理                        未开始
     ...

你：帮我开始学第一门

Agent：
  ✅ 正在打开课程：《创新方法：组合创新与交叉创新》
  ✅ 内置播放助手已注入（16x 倍速，自动启动=是）
  🎬 课程正在自动学习中...

  （视频全部播完后）
  📋 检测到课程评估页面，自动填写并提交...
  ✅ 评估已提交！课程完成。
```

> 💡 核心优势：**不需要记命令、不需要开终端、不需要知道参数格式**。用自然语言告诉 Agent 想做什么，它会调用对应脚本来完成。

---

## ⌨️ 场景三：开发者 / 命令行用户

### 文件结构一览

```
cloud-video-learning/
├── SKILL.md                          # Agent 核心配置文件
├── README.md                         # 本文档
├── scripts/
│   ├── 21tb-login-crawler.js         # ★ 主入口：登录 + 课表 + 打开课程 + 监控播放 + 评估
│   ├── 21tb-course-launcher.js       # 辅助入口：按名称/编号/ID/URL 启动课程
│   ├── 21tb-player-embed.js          # 播放助手注入器 + 评估集成接口
│   ├── 21tb-evaluation-auto.js       # 评估自动完成模块（星级+选择题+论述题+提交）
│   ├── 21tb-status-reporter.js       # 结构化状态上报器（JSON 事件流 + 状态快照）
│   └── package.json                  # npm 依赖
├── runtime-logs/                     # 运行时日志（自动生成）
│   ├── {sessionId}.events.jsonl      #   完整事件流（每行一个 JSON）
│   └── {sessionId}.state.json        #   最新状态快照
├── course-data.json                  # 课表缓存（自动生成）
└── 21tb-video-helper.user.js         # 播放助手源码（可被注入或作为油猴脚本使用）
```

### 命令行参数速查

#### 21tb-login-crawler.js（主脚本）

```bash
node 21tb-login-crawler.js [选项]

必填参数:
  -e, --enterprise <id>    企业ID
  -u, --user <username>    用户名
  -p, --pass <password>    密码

可选参数:
  -c, --course <name>      登录后直接打开指定课程（可重复传入）
  -a, --auto               一键全自动（登录→课表→进入第一个未完成课程）
  --auto-advance           完成当前课后自动推进下一门
  --no-auto-eval           禁用评估自动完成（默认开启）
  --headless               无头模式（不显示浏览器窗口）
  --json                   结构化 JSON 输出（每行一个事件）
  --progress-logs [dir]    自定义日志目录
  -h, --help               显示帮助
```

#### 21tb-course-launcher.js（辅助脚本）

```bash
node 21tb-course-launcher.js [选项] [课程名称...]

  "课程名称"                    通过模糊匹配名称打开
  -l, --url <url>              通过 URL 直接打开
  -i, --id <courseId>          通过课程 ID 打开
  --index <n>                  通过课表序号打开
  -a, --all-unfinished         打开所有未完成课程
  -I, --interactive            交互式选择
  --headless                   无头模式
```

### JSON 事件类型说明

使用 `--json` 时，stdout 每行输出一个 JSON 事件：

| 事件类型 | 含义 |
|---------|------|
| `run_initialized` | 脚本启动 |
| `login_success` | 登录成功 |
| `course_list_saved` | 课表保存完成 |
| `course_opened` | 课程页已打开 |
| `course_start` | 开始学习某门课程 |
| **`eval_complete`** | **课程评估已完成提交** |
| `course_complete` | 某门课程全部完成（含评估） |
| `all_courses_complete` | 全部课程完成 |
| `error` | 错误 |

### 完整自动化流程详解

```
┌─────────────────────────────────────────────────────┐
│  1. 登录阶段                                         │
│     打开登录页 → 切到密码模式 → 填写表单 → 处理弹窗    │
├─────────────────────────────────────────────────────┤
│  2. 课表抓取                                         │
│     导航到 Course Center → 遍历所有分页 → 解析课程卡片 │
├─────────────────────────────────────────────────────┤
│  3. 课程播放                                         │
│     打开播放页 → 注入播放助手 → 16x倍速自动播放        │
│     每30s轮询状态 → 追踪章节/资源进度                  │
├─────────────────────────────────────────────────────┤
│  4. 评估自动完成（视频全播完后）                       │
│     检测到 .course-evaluate                          │
│       → 5星评分 → 选择题全选D → 论述题填固定答案        │
│       → 点击提交 → 处理"进入下一步"弹窗                │
├─────────────────────────────────────────────────────┤
│  5. 自动推进（如启用 --auto-advance）                 │
│     回到步骤3，打开下一门未完成课程                     │
└─────────────────────────────────────────────────────┘
```

---

## 🔧 技术细节

### 平台信息

| 项目 | 值 |
|------|-----|
| 平台地址 | `https://v4.21tb.com/` |
| 登录页 | `/login/login.init.do`（默认二维码） |
| 课程中心 | `/els/html/courseCenter/courseCenter.loadStudyTask.do` |
| 播放页模板 | `/courseSetting/courseLearning/play?courseType=NEW_COURSE_CENTER&courseId={id}` |
| 前端技术栈 | Vue 2 + jQuery + Ant Design + 阿里云播放器 |

### 登录表单赋值方式

平台前端混合使用 jQuery 和原生事件监听，必须双管齐下：

```javascript
// 切换到密码登录（不要点击"Password login here"文案）
if (typeof noErwei === 'function') noErwei();
if (typeof changeWay === 'function')
  changeWay(1, document.getElementById('login-password'));

// jQuery 赋值（平台仍会读这些值）
$('#corpCode').val(enterprise);
$('#loginName').val(username);
$('#swInput').val(password);

// 原生 setter + 事件派发（兼容 Vue / 原生监听）
const nativeSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype, 'value'
).set;
nativeSetter.call(input, value);
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));
input.dispatchEvent(new Event('blur', { bubbles: true }));
```

### 课程卡片 DOM 结构

```html
<li class="nc-course-card nc-mycourse-card">
  <a class="goStudy" data-id="{courseId}">
    <div class="card-img-box"><img src="..." /></div>
  </a>
  <h3>课程名称</h3>
  <!-- Graduation: Post-test / Course Learning -->
  <!-- Progress: Course Learning 67% / Currently completed / Course Assessment -->
  <!-- Type: Optional / Compulsory / Elective -->
</li>
```

### 评估页面 DOM 结构（供调试参考）

| 元素 | CSS 选择器 | 操作 |
|------|-----------|------|
| 评估容器 | `.course-evaluate` | 检测是否进入评估页 |
| 星级评分组 | `.ant-rate[role=radiogroup]` | 点击第5颗 = 5星 |
| 单选题容器 | `.course-test-type-list-item`（不含 textarea 的） | 选 D 项 |
| 单选选项 | `.ant-radio-wrapper[label="d"]` | click |
| 问答题输入框 | `.course-test-type-list-item textarea.ant-input` | 填「很不错，高效」 |
| 提交按钮 | `.course-evaluate-footer .ant-btn-primary` | click |
| 提交后弹窗 | button 文字含"进入下一步" | click 关闭 |

### 播放进度状态接口

```javascript
// 在课程播放页浏览器控制台中读取
const state = window.__TBH_HELPER__.getState();

// state.progress 包含：
{
  totalResources: 15,        // 总资源数
  finishedResources: 8,       // 已完成数
  currentResourceName: "第3章 第2节",
  currentChapterIdx: 2,
  currentSectionIdx: 1,
  courseCompleted: false,     // 本门是否完成
}
```

---

## ❓ 常见问题

**Q: 登录失败怎么办？**
A: 检查企业ID、用户名、密码。平台可能弹出验证码或二次确认弹窗，脚本会尝试自动处理。

**Q: 课表为空？**
A: 等待 SPA 渲染完成。课程列表异步加载，脚本会等待 `.nc-mycourse-card` 出现。

**Q: 打开后没有自动播放？**
A: 终端是否有「内置播放助手已注入」日志？如果没有，可能是页面结构变化了。后备方案：把 `21tb-video-helper.user.js` 装到 Tampermonkey。

**Q: 评估问卷不想自动填？**
A: 启动时加 `--no-auto-eval` 参数。

**Q: 可以同时开多门课吗？**
A: 可以，建议不超过 3 个。每个标签页独立运行一份播放助手。

**Q: 怎么看学完没有？**
A: 看 `runtime-logs/` 下最新的 `{*.state.json}` 中 `currentCourseProgress.courseCompleted`，或事件流里的 `course_complete` / `all_courses_complete`。

**Q: 自动推进卡住了？**
A: 脚本每 30s 轮询一次状态。如果异常，手动刷新课程页，播放助手会自动恢复。
