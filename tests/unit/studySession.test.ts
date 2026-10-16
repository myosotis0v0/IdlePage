import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StudySession } from '../../src/application/StudySession';
import type { Question } from '../../src/domain/remoteProtocol';

const choice = (qid: string): Question => ({ qid, view: { prompt: qid, audio: [], answer: { type: 'choice', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correct: 'a' } } });
const card = (qid: string): Question => ({ qid, view: { prompt: qid, audio: [], answer: { type: 'self', back: 'back', grades: [
  { rating: 1, label: '不认识', again: true }, { rating: 2, label: '模糊', again: true }, { rating: 3, label: '认识', again: false }] } } });

test('choice cards are judged locally, shown as feedback, and submitted with the lesson echo', () => {
  let now = 1000;
  const s = new StudySession('ear', '练耳', { echo: { unit: 'int', level: 0 }, questions: [choice('q1'), choice('q2')] }, () => now);
  assert.equal(s.reveal(), false);
  now = 2500; assert.ok(s.choose('b'));
  assert.deepEqual(s.choice, { picked: 'b', correct: false });
  assert.equal(s.choose('a'), false, 'one answer per card');
  assert.ok(s.advance());
  assert.ok(s.choose('a')); assert.ok(s.advance());
  assert.equal(s.phase, 'finished');
  assert.deepEqual(s.score, { correct: 1, answered: 2 });
  const body = s.submission('2026-10-15')!;
  assert.deepEqual({ ...body, lesson_id: undefined }, { unit: 'int', level: 0, lesson_id: undefined, day: '2026-10-15', answers: [
    { qid: 'q1', answer: 'b', retry: false, ms: 1500 }, { qid: 'q2', answer: 'a', retry: false, ms: 0 }] });
  assert.match(String(body.lesson_id), /^[a-f0-9]{24}$/);
});

test('self cards reveal, then grades marked again come back three and then five cards later', () => {
  const s = new StudySession('n2', 'N2', { echo: {}, questions: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'].map(card) });
  assert.equal(s.grade(3), false, 'grading needs the back side');
  assert.ok(s.reveal()); assert.ok(s.grade(1));
  assert.equal(s.total, 8);
  const order = [];
  while (s.phase !== 'finished') { order.push(s.current!.qid); s.reveal(); s.grade(order.length === 4 ? 2 : 3); }
  // w1 again after w2, w3, w4 (third later); graded 2 there, so once more five cards later.
  assert.deepEqual(order, ['w2', 'w3', 'w4', 'w1', 'w5', 'w6', 'w7', 'w1']);
  assert.deepEqual(s.answers.filter(a => a.qid === 'w1').map(a => 'rating' in a && a.rating), [1, 2, 3]);
});

test('nothing answered means nothing to submit', () => {
  assert.equal(new StudySession('x', 'x', { echo: {}, questions: [card('w')] }).submission('2026-10-15'), undefined);
});
