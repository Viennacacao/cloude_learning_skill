/**
 * 21tb-evaluation-auto.js
 * 
 * 自动完成 21tb 时光易学平台的 Course Evaluation（课程评估）页面
 * 
 * 功能：
 *   1. 检测是否进入评估页面（.course-evaluate 容器）
 *   2. 星级评分 → 打 5 颗星
 *   3. 单选题（Multiple Choice）→ 全部选 D 选项
 *   4. 问答题（Essay Question）→ 固定填「很不错，高效」
 *   5. 点击提交按钮
 * 
 * 使用方式：
 *   方式一：通过 Puppeteer page.evaluate() 调用（推荐）
 *     await page.evaluate(() => { if(window.__TBH_EVAL_AUTO__) return window.__TBH_EVAL_AUTO__.fillAndSubmit(); })
 *   
 *   方式二：作为油猴脚本注入浏览器
 *     
 *   方式三：被 21tb-login-crawler.js / 21tb-course-launcher.js 引入调用
 */

// ============================================================
// 浏览器端模块 — 注入到课程评估页面中自动执行
// ============================================================

(function () {
  'use strict';

  // 防止重复注入
  if (window.__TBH_EVAL_AUTO__) {
    console.log('[TBH-EvalAuto] Already initialized, skipping.');
    return;
  }

  const EVAL_CONFIG = {
    // 星级评分：打几颗星 (1-5)
    starRating: 5,
    // 单选题选择哪个选项 ('a' | 'b' | 'c' | 'd' | 'e')
    choiceOption: 'd',
    // 问答题固定答案
    essayAnswer: '很不错，高效',
    // 每步操作的间隔时间 (ms)，模拟人类操作节奏
    stepDelay: 300,
    // 提交前额外等待时间 (ms)
    preSubmitDelay: 500,
    // 是否在提交后自动处理弹窗/提示
    autoHandlePostSubmit: true,
    // 最大等待评估页出现的轮询次数
    maxPollCount: 60,       // 60 * 500ms = 30秒
    pollInterval: 500,      // 每 500ms 检查一次
    // 是否启用日志
    logging: true,
  };

  const EvalAuto = {
    _filled: false,
    _submitted: false,

    /**
     * 日志输出
     */
    log(msg) {
      if (EVAL_CONFIG.logging) {
        console.log(`[TBH-EvalAuto] ${new Date().toLocaleTimeString()} ${msg}`);
      }
    },

    /**
     * 延迟工具函数
     */
    sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },

    /**
     * 检测当前页面是否是 Course Evaluation 页面
     * 
     * 2026-07-03 修复：21tb 评估页从前端 Ant Design 迁移到 Element UI，
     * 不再有 .course-evaluate 容器。改为检测评估表单特征元素：
     *   - .el-rate (Element UI 星级评分组件)
     *   - .ant-rate (旧版 Ant Design 星级评分组件，兼容)
     *   - 同时存在评分组件 + 提交按钮时判定为评估页
     * @returns {boolean}
     */
    isEvaluationPage() {
      // 关键兜底：正在播放视频 → 不是评估页
      const activeVideo = Array.from(document.querySelectorAll('video')).find(v => {
        if (v.paused || v.ended || v.readyState < 2) return false;
        if (v.currentTime <= 0) return false;
        return true;
      });
      if (activeVideo) return false;

      // 兜底：存在视频资源容器 → 不是评估页
      if (document.querySelector('.chapter-container, .learning-container, .section-list, .catalogue-wrap')) {
        return false;
      }

      // 主检测：Element UI 的 el-rate 或 Ant Design 的 ant-rate
      const hasRate = !!document.querySelector('.el-rate, .ant-rate');
      // 补充：检测提交按钮（避免误判课程评分展示页）
      const hasSubmitBtn = !!document.querySelector('.ant-btn-primary');
      // 检测文本域（评估通常有论述题）
      const hasTextarea = !!document.querySelector('textarea');

      return hasRate && (hasSubmitBtn || hasTextarea);
    },

    /**
     * 等待评估页面出现
     * @param {number} timeout - 最大等待毫秒数
     * @returns {Promise<boolean>}
     */
    async waitForEvaluationPage(timeout = 30000) {
      const start = Date.now();
      let count = 0;
      while (Date.now() - start < timeout) {
        if (this.isEvaluationPage()) {
          this.log('✅ Evaluation page detected!');
          return true;
        }
        count++;
        if (count % 10 === 0) {
          this.log(`⏳ Waiting for evaluation page... (${count * EVAL_CONFIG.pollInterval}ms)`);
        }
        await this.sleep(EVAL_CONFIG.pollInterval);
      }
      this.log('❌ Timeout waiting for evaluation page.');
      return false;
    },

    /**
     * 步骤1：星级评分 — 打 5 颗星
     * 
     * 兼容两种 UI 框架：
     *   - Element UI: .el-rate > .el-rate__item > .el-rate__icon
     *   - Ant Design: .ant-rate > .ant-rate-star > [role="radio"]
     */
    async fillStarRating() {
      this.log('⭐ Step 1: Filling star rating...');

      // 尝试多种选择器寻找评分容器（Element UI 优先，Ant Design 备选）
      const rateGroup = document.querySelector('.el-rate') ||
                        document.querySelector('.ant-rate') ||
                        document.querySelector('[class*="rate"]');

      if (!rateGroup) {
        this.log('⚠️ Star rating group not found, skipping.');
        return false;
      }

      this.log(`  Detected: ${rateGroup.className.substring(0, 30)}`);

      // Element UI 星星结构: .el-rate__item
      // Ant Design 星星结构: .ant-rate-star
      const stars = rateGroup.querySelectorAll('.el-rate__item, .ant-rate-star, [class*="rate__item"], [class*="rate-star"]');
      if (stars.length === 0) {
        this.log('⚠️ No star elements found, skipping.');
        return false;
      }

      const targetIndex = Math.min(EVAL_CONFIG.starRating - 1, stars.length - 1);
      const targetStar = stars[targetIndex];
      
      // Element UI: 点击 .el-rate__icon
      // Ant Design: 点击 [role="radio"] 或 .ant-rate-star-first
      const clickableEl = targetStar.querySelector('.el-rate__icon') ||
                          targetStar.querySelector('[role="radio"]') ||
                          targetStar.querySelector('.ant-rate-star-first') ||
                          targetStar;
      
      this._click(clickableEl);
      this.log(`⭐ Rated ${EVAL_CONFIG.starRating} stars (clicked star #${targetIndex + 1} / ${stars.length})`);

      await this.sleep(EVAL_CONFIG.stepDelay);
      return true;
    },

    /**
     * 步骤2：单选题 — 所有题目都选指定选项（默认 D）
     * 
     * 兼容 Element UI (.el-radio) 和 Ant Design (.ant-radio-wrapper)
     */
    async fillMultipleChoice() {
      this.log(`📝 Step 2: Filling multiple choice (select option "${EVAL_CONFIG.choiceOption.toUpperCase()}")...`);

      // 寻找题目容器，尝试多种可能的类名
      const questionItems = document.querySelectorAll('.course-test-type-list-item') || 
                            document.querySelectorAll('.course-test-item') ||
                            document.querySelectorAll('[class*="test-type-list-item"]') ||
                            document.querySelectorAll('[class*="question-item"]');

      if (questionItems.length === 0) {
        this.log('⚠️ No question items found, skipping multiple choice.');
        return false;
      }

      let filledCount = 0;

      for (let i = 0; i < questionItems.length; i++) {
        const item = questionItems[i];

        // 跳过简答题（包含 textarea 或明显标记为简答的容器）
        if (item.querySelector('textarea') || item.textContent.includes('简答') || item.textContent.includes('论述')) {
          this.log(`  - Q${i + 1}: Detected as essay/textarea, skipping in MC step.`);
          continue;
        }

        // 寻找选项容器（Element UI: .el-radio, Ant Design: .ant-radio-wrapper）
        const options = item.querySelectorAll('.el-radio, .ant-radio-wrapper, .ant-checkbox-wrapper, [class*="radio-wrapper"], [class*="radio"]');
        if (options.length === 0) {
          // 如果 item 本身没有选项，可能在全局范围内
          this.log(`  ⚠️ Q${i + 1}: No options found in item container.`);
          continue;
        }

        // 目标选项定位逻辑
        let targetOption = null;
        const targetText = EVAL_CONFIG.choiceOption.toUpperCase();

        // 1. 根据文本内容查找 (A/B/C/D)
        targetOption = Array.from(options).find(opt => {
          const text = opt.textContent.trim().toUpperCase();
          return text === targetText || text.startsWith(targetText + '.') || text.startsWith(targetText + ' ') || text.startsWith(targetText + '、');
        });

        // 2. 根据 label 属性查找 (AntD)
        if (!targetOption) {
          targetOption = item.querySelector(`.ant-radio-wrapper[label="${EVAL_CONFIG.choiceOption}"], .ant-radio-wrapper[label="${targetText}"]`);
        }

        // 3. 根据索引 Fallback (D 是第 4 个)
        if (!targetOption && EVAL_CONFIG.choiceOption === 'd' && options.length >= 4) {
          targetOption = options[3];
          this.log(`  - Q${i + 1}: Option D not found by text/label, using 4th index fallback.`);
        } else if (!targetOption && options.length > 0) {
          targetOption = options[options.length - 1];
          this.log(`  - Q${i + 1}: Target option not found, using last option fallback.`);
        }

        if (targetOption) {
          // Element UI radio: 需要点击 .el-radio__input 或 label
          const elRadioInput = targetOption.querySelector('.el-radio__input, .el-radio__original');
          const clickTarget = elRadioInput || targetOption;
          this._click(clickTarget);
          filledCount++;
          
          const titleEl = item.querySelector('.course-test-type-list-item-title-content') || item.querySelector('[class*="title"]');
          const titleText = titleEl ? titleEl.textContent.trim().substring(0, 30) : `Question #${i + 1}`;
          this.log(`  ✓ Q${i + 1}: [${titleText}...] → Selected (via ${targetOption.className.substring(0, 30)})`);
        }

        await this.sleep(EVAL_CONFIG.stepDelay);
      }

      this.log(`📝 Multiple choice completed: ${filledCount} questions answered.`);
      return filledCount > 0;
    },

    /**
     * 步骤3：问答题 — 填写固定答案
     */
    async fillEssayQuestion() {
      this.log(`📝 Step 3: Filling essay question...`);

      // 查找所有可能的文本输入框（兼容 Element UI 和 Ant Design）
      const textareas = document.querySelectorAll('textarea.ant-input, .course-test-type-list-item textarea, .course-evaluate textarea, .el-textarea__inner, textarea');
      
      if (textareas.length === 0) {
        this.log('⚠️ No essay textarea found, skipping.');
        return false;
      }

      for (let i = 0; i < textareas.length; i++) {
        const ta = textareas[i];
        
        // 确保元素可见且可用
        if (ta.offsetParent === null) continue; 

        this._fillTextarea(ta, EVAL_CONFIG.essayAnswer);

        // 获取问题标题（可选）
        const parentItem = ta.closest('.course-test-type-list-item') || ta.closest('[class*="item"]');
        const titleEl = parentItem?.querySelector('.course-test-type-list-item-title-content') || parentItem?.querySelector('[class*="title"]');
        const titleText = titleEl ? titleEl.textContent.trim().substring(0, 30) : `Essay #${i + 1}`;
        this.log(`  ✓ Essay ${i + 1}: [${titleText}...] → "${EVAL_CONFIG.essayAnswer}"`);
      }

      this.log(`📝 Essay completed: ${textareas.length} answer(s) filled.`);
      return true;
    },

    /**
     * 步骤4：点击提交按钮 + 处理提交后的弹窗
     */
    async clickSubmit() {
      this.log('🚀 Step 4: Clicking submit button...');

      // 先等待一小段时间确保所有填写操作完成
      await this.sleep(EVAL_CONFIG.preSubmitDelay);

      // 查找提交按钮 — 兼容 Element UI (.el-button) 和 Ant Design (.ant-btn)
      // 优先按文字匹配（排除"关闭/取消"类按钮）
      const submitTexts = ['提交', '提 交', '确定', '确 定', '提交评估', '保存', '保 存'];
      const closeTexts = ['关 闭', '关闭', '取消', '取 消', '返回', '返 回'];
      
      let btn = document.querySelector('.course-evaluate-footer .ant-btn-primary') ||
                document.querySelector('.course-evaluate .ant-btn-primary') ||
                document.querySelector('.course-evaluate-footer .el-button--primary');
      
      if (btn) {
        const text = btn.textContent.trim();
        if (closeTexts.some(t => text.includes(t))) btn = null;
      }
      
      if (!btn) {
        const allBtns = Array.from(document.querySelectorAll('button, .ant-btn, .el-button'));
        // 首先按文字匹配提交类按钮
        btn = allBtns.find(b => {
          const text = b.textContent.trim();
          return submitTexts.some(t => text.includes(t)) && !closeTexts.some(t => text.includes(t));
        });
        // 兜底：选 primary 按钮（排除 close 类）
        if (!btn) {
          btn = allBtns.find(b => {
            const text = b.textContent.trim();
            const isPrimary = b.classList.contains('el-button--primary') || b.classList.contains('ant-btn-primary');
            return isPrimary && !closeTexts.some(t => text.includes(t));
          });
        }
      }

      if (!btn) {
        this.log('❌ Submit button not found!');
        return false;
      }

      this.log(`🚀 Submit button found: "${btn.textContent.trim()}"`);
      
      // 确保按钮是可点击的
      if (btn.disabled || btn.classList.contains('ant-btn-loading')) {
        this.log('⚠️ Submit button is disabled or loading, waiting...');
        await this.sleep(1000);
      }

      this._click(btn);
      this.log('✅ Submit button clicked!');

      // Step 4.5: 处理提交后可能出现的确认弹窗
      if (EVAL_CONFIG.autoHandlePostSubmit) {
        await this._handlePostSubmitModal();
      }

      return true;
    },

    /**
     * 提交后处理弹窗 — 点击"进入下一步"或关闭提示
     */
    async _handlePostSubmitModal() {
      this.log('⏳ Waiting for post-submit modal...');
      
      let closeAttemptCount = 0;
      const maxCloseAttempts = 5;
      
      // 等待弹窗出现（最多 8 秒，因为后端处理可能慢）
      for (let i = 0; i < 16; i++) {
        await this.sleep(500);

        // 尝试查找"进入下一步"、"下一节"等按钮（评估提交成功后出现）
        const nextBtn = Array.from(document.querySelectorAll('button, .ant-btn, .el-button'))
          .find(b => {
            const t = b.textContent.trim();
            return t.includes('进入下一步') || t.includes('下一节') || t.includes('继续学习');
          });
        
        if (nextBtn) {
          this.log(`✅ Post-submit action detected: "${nextBtn.textContent.trim()}", clicking...`);
          this._click(nextBtn);
          await this.sleep(500);
          return true;
        }

        // 尝试查找"确定"/"知道了"/"关闭"等确认按钮
        const confirmBtn = Array.from(document.querySelectorAll('button, .ant-btn, .el-button'))
          .find(b => /^(确定|知道了|OK|关 闭|关闭|确认)$/.test(b.textContent.trim()));
        
        if (confirmBtn && closeAttemptCount < maxCloseAttempts) {
          this.log(`✅ Confirm button found: "${confirmBtn.textContent.trim()}", clicking...`);
          this._click(confirmBtn);
          closeAttemptCount++;
          await this.sleep(600);
          
          // 点击关闭后，额外尝试点击遮罩层（防止蒙层遮罩阻挡后续操作）
          const mask = document.querySelector('.el-overlay, .el-dialog__wrapper, .ant-modal-mask, .v-modal');
          if (mask) {
            this._click(mask);
            this.log('  Also clicked modal mask/overlay');
          }
          // 持续循环检查
          continue;
        }

        // 额外尝试：Element UI dialog header close icon
        const elCloseBtn = document.querySelector('.el-message-box__close, .el-dialog__close, .el-icon-close');
        if (elCloseBtn) {
          this.log(`  Found EL close icon, clicking...`);
          this._click(elCloseBtn);
          await this.sleep(500);
          continue;
        }
      }

      // 循环结束后，强制尝试关闭遮罩和弹窗
      this.log('  Force-closing any remaining modals...');
      // Press Escape key
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      await this.sleep(500);
      
      // Click all masks/overlays
      const masks = document.querySelectorAll('.el-overlay, .v-modal, .ant-modal-mask');
      masks.forEach(m => this._click(m));

      this.log('ℹ️ Post-submit modal handling finished.');
      return false;
    },

    /**
     * 完整流程：检测并填写提交评估
     * @param {{starRating?: number, choiceOption?: string, essayAnswer?: string}} options
     * @returns {Promise<{success: boolean, steps: Object}>}
     */
    async fillAndSubmit(options = {}) {
      if (this._submitted && this._filled) {
        this.log('Already submitted, skipping.');
        return { success: true, steps: { alreadyDone: true } };
      }

      // 等待页面完全加载后再开始填写
      this.log('⏳ 等待 3 秒让评估页面完全加载...');
      await new Promise(r => setTimeout(r, 3000));

      // 合并配置
      if (options.starRating) EVAL_CONFIG.starRating = options.starRating;
      if (options.choiceOption) EVAL_CONFIG.choiceOption = options.choiceOption.toLowerCase();
      if (options.essayAnswer) EVAL_CONFIG.essayAnswer = options.essayAnswer;

      this.log('========================================');
      this.log('🎯 Starting Course Evaluation Auto-Fill');
      this.log(`   Stars: ${EVAL_CONFIG.starRating}, Choice: ${EVAL_CONFIG.choiceOption.toUpperCase()}, Essay: "${EVAL_CONFIG.essayAnswer}"`);
      this.log('========================================');

      const results = {};

      // 检查是否在评估页
      if (!this.isEvaluationPage()) {
        this.log('⚠️ Not on evaluation page. Waiting for it to appear...');
        const found = await this.waitForEvaluationPage();
        if (!found) {
          return { success: false, error: 'Evaluation page did not appear within timeout', steps: results };
        }
      }

      try {
        await this.sleep(EVAL_CONFIG.stepDelay);
        // Step 1: Star Rating
        results.starRating = await this.fillStarRating();

        await this.sleep(EVAL_CONFIG.stepDelay);
        // Step 2: Multiple Choice
        results.multipleChoice = await this.fillMultipleChoice();

        await this.sleep(EVAL_CONFIG.stepDelay);
        // Step 3: Essay Question
        results.essayQuestion = await this.fillEssayQuestion();

        await this.sleep(EVAL_CONFIG.stepDelay);
        // Step 4: Submit
        results.submit = await this.clickSubmit();

        this._filled = true;
        this._submitted = true;

        this.log('========================================');
        this.log(results.submit
          ? '🎉 Evaluation completed and submitted successfully!'
          : '⚠️ Evaluation filled but submit may have issues.');
        this.log('========================================');

        // 触发自定义事件，通知外部脚本
        window.dispatchEvent(new CustomEvent('tbh-eval-complete', {
          detail: { success: results.submit, results }
        }));

        return { success: results.submit, steps: results };

      } catch (err) {
        this.log(`❌ Error during evaluation: ${err.message}`);
        return { success: false, error: err.message, steps: results };
      }
    },

    /**
     * 仅填写不提交（用于调试或需要用户确认的场景）
     */
    async fillOnly(options = {}) {
      if (options.starRating) EVAL_CONFIG.starRating = options.starRating;
      if (options.choiceOption) EVAL_CONFIG.choiceOption = options.choiceOption.toLowerCase();
      if (options.essayAnswer) EVAL_CONFIG.essayAnswer = options.essayAnswer;

      this.log('📝 Fill-only mode (no submit)...');

      if (!this.isEvaluationPage()) {
        const found = await this.waitForEvaluationPage();
        if (!found) return { success: false, error: 'Evaluation page not found' };
      }

      const results = {};
      results.starRating = await this.fillStarRating();
      results.multipleChoice = await this.fillMultipleChoice();
      results.essayQuestion = await this.fillEssayQuestion();
      this._filled = true;

      this.log('📝 Fill-only complete (not submitted). Call fillAndSubmit() or clickSubmit() to submit.');
      return { success: true, steps: results };
    },

    // ---- 内部工具方法 ----

    /**
     * 模拟真实点击
     */
    _click(el) {
      if (!el) return;
      
      // 1. 触发 MouseEvents
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      
      const options = { bubbles: true, cancelable: true, clientX: x, clientY: y };
      el.dispatchEvent(new MouseEvent('mousedown', options));
      el.dispatchEvent(new MouseEvent('mouseup', options));
      el.dispatchEvent(new MouseEvent('click', options));

      // 2. 对于原生 input/radio，尝试直接调用 click()
      if (el.tagName === 'INPUT' || (el.querySelector && el.querySelector('input'))) {
        const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
        if (input && input !== el) {
          input.click();
        }
      }

      // 3. 最终兜底调用原生 click
      if (typeof el.click === 'function') {
        el.click();
      }
    },

    /**
     * 填充 textarea（模拟输入）
     */
    _fillTextarea(textarea, value) {
      if (!textarea) return;
      // 设置值并触发 input 事件（Vue/Ant Design 需要）
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;
      
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(textarea, value);
      } else {
        textarea.value = value;
      }
      
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    },
  };

  // 挂载到全局
  window.__TBH_EVAL_AUTO__ = EvalAuto;

  // 如果已经在评估页面上，立即尝试自动执行
  // （可选：去掉下面这行的注释即可启用「进入页面后立即自动填写」模式）
  if (EvalAuto.isEvaluationPage()) {
    EvalAuto.fillAndSubmit();
  }

  console.log('[TBH-EvalAuto] Module initialized. Call window.__TBH_EVAL_AUTO__.fillAndSubmit() to start.');
})();
