const test = require('node:test');
const assert = require('node:assert/strict');

// 先写测试：该模块应提供严格完成判定
const { isCourseCompleteStrict } = require('../21tb-progress-guard');

test('isCourseCompleteStrict: totalResources=0 永不完成', () => {
  assert.equal(
    isCourseCompleteStrict({ courseCompleted: true, totalResources: 0, finishedResources: 0 }),
    false
  );
});

test('isCourseCompleteStrict: 资源未全部完成时不完成', () => {
  assert.equal(
    isCourseCompleteStrict({ courseCompleted: true, totalResources: 10, finishedResources: 9 }),
    false
  );
});

test('isCourseCompleteStrict: courseCompleted=false 时不完成', () => {
  assert.equal(
    isCourseCompleteStrict({ courseCompleted: false, totalResources: 10, finishedResources: 10 }),
    false
  );
});

test('isCourseCompleteStrict: total>0 且 finished==total 且 courseCompleted=true 才完成', () => {
  assert.equal(
    isCourseCompleteStrict({ courseCompleted: true, totalResources: 10, finishedResources: 10 }),
    true
  );
});

