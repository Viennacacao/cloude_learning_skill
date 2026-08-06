const test = require('node:test');
const assert = require('node:assert/strict');

const { parseJsonArray, normalizeChoiceAnswer, isTransientPageError } = require('./agent');

test('parseJsonArray accepts plain and fenced JSON arrays', () => {
  assert.deepEqual(parseJsonArray('[{"index":0,"answer":"A"}]'), [{ index: 0, answer: 'A' }]);
  assert.deepEqual(
    parseJsonArray('```json\n[{"index":1,"answer":["A","C"]}]\n```'),
    [{ index: 1, answer: ['A', 'C'] }]
  );
});

test('normalizeChoiceAnswer rejects options outside the visible choices', () => {
  assert.equal(normalizeChoiceAnswer('D', 'single', ['A', 'B', 'C']), '');
  assert.equal(normalizeChoiceAnswer('b', 'single', ['A', 'B', 'C']), 'B');
  assert.equal(normalizeChoiceAnswer('答案是 B', 'single', ['A', 'B', 'C']), 'B');
  assert.deepEqual(normalizeChoiceAnswer('AC', 'multiple', ['A', 'B', 'C']), ['A', 'C']);
  assert.deepEqual(normalizeChoiceAnswer(['C', 'A', 'X', 'A'], 'multiple', ['A', 'B', 'C']), ['C', 'A']);
});

test('isTransientPageError only accepts navigation-related frame failures', () => {
  assert.equal(isTransientPageError(new Error("Attempted to use detached Frame 'abc'")), true);
  assert.equal(isTransientPageError(new Error('Execution context was destroyed, most likely because of a navigation')), true);
  assert.equal(isTransientPageError(new Error('Post-test submit button not found')), false);
});
