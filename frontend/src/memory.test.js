import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeMemory } from './memory.js';

test('new answers replace older answers to the same question', () => {
  const memory = mergeMemory(
    [{ question: 'Preferred language?', answer: 'Java' }],
    [{ question: 'preferred language?', answer: 'Python' }],
  );

  assert.deepEqual(memory, [
    { question: 'preferred language?', answer: 'Python' },
  ]);
});

test('invalid and duplicate memory entries are discarded', () => {
  const memory = mergeMemory([], [
    { question: 'Response style?', answer: 'Brief' },
    { question: 'Response style?', answer: 'Detailed' },
    { question: '', answer: 'Ignored' },
  ]);

  assert.deepEqual(memory, [
    { question: 'Response style?', answer: 'Detailed' },
  ]);
});

test('memory is bounded to the latest 24 entries', () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({
    question: `Question ${index}`,
    answer: `Answer ${index}`,
  }));

  const memory = mergeMemory([], entries);

  assert.equal(memory.length, 24);
  assert.equal(memory[0].question, 'Question 6');
  assert.equal(memory[23].question, 'Question 29');
});
