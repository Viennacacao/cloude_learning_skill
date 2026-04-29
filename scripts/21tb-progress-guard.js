/**
 * 严格完成判定（用于避免 0/0 误判完成）
 * @param {Object} p helper.getState().progress
 * @returns {boolean}
 */
function isCourseCompleteStrict(p) {
  if (!p) return false;
  const total = Number(p.totalResources || 0);
  const finished = Number(p.finishedResources || 0);
  if (total <= 0) return false;
  if (!p.courseCompleted) return false;
  return finished >= total;
}

module.exports = { isCourseCompleteStrict };

