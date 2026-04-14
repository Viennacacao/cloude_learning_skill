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
     * @returns {boolean}
     */
    isEvaluationPage() {
      return !!document.querySelector('.course-evaluate');
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
     */
    async fillStarRating() {
      this.log('⭐ Step 1: Filling star rating...');

      const rateGroup = document.querySelector('.ant-rate[role="radiogroup"]');
      if (!rateGroup) {
        this.log('⚠️ Star rating group not found, skipping.');
        return false;
      }

      const stars = rateGroup.querySelectorAll('.ant-rate-star');
      if (stars.length === 0) {
        this.log('⚠️ No star elements found, skipping.');
        return false;
      }

      const targetIndex = Math.min(EVAL_CONFIG.starRating - 1, stars.length - 1);
      const targetStar = stars[targetIndex];
      
      // 找到 role=radio 的元素并点击（Ant Design Rate 组件结构）
      const radioEl = targetStar.querySelector('[role="radio"]') || targetStar;
      
      this._click(radioEl);
      this.log(`⭐ Rated ${EVAL_CONFIG.starRating} stars (clicked star #${targetIndex + 1})`);

      await this.sleep(EVAL_CONFIG.stepDelay);
      return true;
    },

    /**
     * 步骤2：单选题 — 所有题目都选指定选项（默认 D）
     */
    async fillMultipleChoice() {
      this.log(`📝 Step 2: Filling multiple choice (select option "${EVAL_CONFIG.choiceOption.toUpperCase()}")...`);

      // 找到所有选择题的题目容器
      const questionItems = document.querySelectorAll('.course-test-type-list-item');
      if (questionItems.length === 0) {
        this.log('⚠️ No question items found, skipping multiple choice.');
        return false;
      }

      let filledCount = 0;

      for (let i = 0; i < questionItems.length; i++) {
        const item = questionItems[i];

        // 跳过问答题（包含 textarea 的容器）
        if (item.querySelector('textarea')) {
          continue;  // 这个留给步骤3处理
        }

        // 在当前题目中查找目标选项
        // Ant Design Radio 结构: label.ant-radio-wrapper[label="d"] > span.ant-radio > input
        const targetLabel = item.querySelector(`.ant-radio-wrapper[label="${EVAL_CONFIG.choiceOption}"]`);
        
        if (targetLabel) {
          this._click(targetLabel);
          filledCount++;
          
          // 获取题目文本（用于日志）
          const titleEl = item.querySelector('.course-test-type-list-item-title-content');
          const titleText = titleEl ? titleEl.textContent.trim().substring(0, 40) : `Question #${i + 1}`;
          this.log(`  ✓ Q${i + 1}: [${titleText}...] → Selected ${EVAL_CONFIG.choiceOption.toUpperCase()}`);
        } else {
          this.log(`  ⚠️ Q${i + 1}: Option "${EVAL_CONFIG.choiceOption}" not found, trying fallback.`);
          
          // Fallback: 尝试点击第 4 个选项（D 通常排在第 4 位）
          const allLabels = item.querySelectorAll('.ant-radio-wrapper');
          if (allLabels.length >= 4) {
            this._click(allLabels[3]);  // index 3 = D (0-based)
            filledCount++;
            this.log(`  ✓ Q${i + 1}: Fallback → clicked 4th option.`);
          }
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
      this.log(`📝 Step 3: Filling essay question with fixed answer...`);

      const textareas = document.querySelectorAll('.course-test-type-list-item textarea.ant-input');
      
      if (textareas.length === 0) {
        // 也尝试更宽泛的选择器
        const anyTextarea = document.querySelector('.course-evaluate textarea');
        if (anyTextarea) {
          this._fillTextarea(anyTextarea, EVAL_CONFIG.essayAnswer);
          this.log(`📝 Essay answer filled (fallback selector).`);
          return true;
        }
        this.log('⚠️ No essay textarea found, skipping.');
        return false;
      }

      for (let i = 0; i < textareas.length; i++) {
        const ta = textareas[i];
        this._fillTextarea(ta, EVAL_CONFIG.essayAnswer);

        // 获取问题标题
        const parentItem = ta.closest('.course-test-type-list-item');
        const titleEl = parentItem?.querySelector('.course-test-type-list-item-title-content');
        const titleText = titleEl ? titleEl.textContent.trim().substring(0, 40) : `Essay #${i + 1}`;
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

      // 查找提交按钮 — 优先使用精确选择器
      let btn = document.querySelector('.course-evaluate-footer .ant-btn-primary');
      
      // Fallback: 查找任何包含"提交"文字的按钮
      if (!btn) {
        const allBtns = Array.from(document.querySelectorAll('button'));
        btn = allBtns.find(b => b.textContent.trim().includes('提交') || b.textContent.trim().includes('提 交'));
      }

      if (!btn) {
        this.log('❌ Submit button not found!');
        return false;
      }

      this.log(`🚀 Submit button found: "${btn.textContent.trim()}"`);
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
      
      // 等待弹窗出现（最多 5 秒）
      for (let i = 0; i < 10; i++) {
        await this.sleep(500);

        // 尝试查找"进入下一步"按钮（评估提交成功后出现）
        const nextBtn = Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent.includes('进入下一步'));
        
        if (nextBtn) {
          this.log('✅ Post-submit modal detected, clicking "Next Step"...');
          this._click(nextBtn);
          await this.sleep(500);
          return true;
        }

        // 尝试查找"确定"/"知道了"/"关闭"等确认按钮
        const confirmBtn = Array.from(document.querySelectorAll('button'))
          .find(b => /^(确定|知道了|OK|关 闭|关闭)$/.test(b.textContent.trim()));
        
        if (confirmBtn) {
          this.log(`✅ Confirm button found: "${confirmBtn.textContent.trim()}"`);
          this._click(confirmBtn);
          await this.sleep(300);
          return true;
        }
      }

      this.log('ℹ️ No post-submit modal detected (or already dismissed).');
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
      // 使用 MouseEvent 触发，更接近真实用户行为
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
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
