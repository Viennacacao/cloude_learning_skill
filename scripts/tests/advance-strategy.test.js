const test = require('node:test');
const assert = require('node:assert/strict');

const { decideAdvanceAction } = require('../21tb-advance-strategy');

test('finish=true => immediate component jump', () => {
  assert.deepEqual(
    decideAdvanceAction({ currentFinished: true, stuckCount: 0, nextButtonVisible: true }),
    { type: 'jump', via: 'component', delayMs: 0 }
  );
});

test('finish=false + ended => delay 3000 then click next', () => {
  assert.deepEqual(
    decideAdvanceAction({ currentFinished: false, videoEnded: true, stuckCount: 0, nextButtonVisible: true }),
    { type: 'next', via: 'button', delayMs: 3000 }
  );
});

test('finish=false + not ended => wait', () => {
  assert.deepEqual(
    decideAdvanceAction({ currentFinished: false, videoEnded: false, stuckCount: 0, nextButtonVisible: false }),
    { type: 'wait', via: 'none', delayMs: 0 }
  );
});

test('nextButtonVisible=true 时必须包含 3s 延迟', () => {
  assert.deepEqual(
    decideAdvanceAction({ currentFinished: false, videoEnded: false, stuckCount: 0, nextButtonVisible: true }),
    { type: 'next', via: 'button', delayMs: 3000 }
  );
});
