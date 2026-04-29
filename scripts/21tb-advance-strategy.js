/**
 * 混合推进策略（纯函数、可测试）
 *
 * 规则：
 * - currentFinished=true：立即跳过（组件切换），不等待
 * - currentFinished=false 且 videoEnded=true 且 nextButtonVisible=true：等待 3 秒再点按钮（触发完成标记）
 * - 其他情况：等待
 */
function decideAdvanceAction(input = {}) {
  const currentFinished = !!input.currentFinished;
  const videoEnded = !!input.videoEnded;
  const nextButtonVisible = !!input.nextButtonVisible;

  if (currentFinished) {
    return { type: 'jump', via: 'component', delayMs: 0 };
  }

  // 平台上 nextButton 往往“播完才出现”，但也可能在某些场景先出现；
  // 为了强制触发 completed，我们只要看到 nextButtonVisible 就要求 3 秒延迟再点。
  if (nextButtonVisible) {
    return { type: 'next', via: 'button', delayMs: 3000 };
  }

  return { type: 'wait', via: 'none', delayMs: 0 };
}

module.exports = { decideAdvanceAction };
