import { randomBytes } from 'node:crypto';
import type { Lesson, Question } from '../domain/remoteProtocol';

export type StudyPhase = 'front' | 'revealed' | 'answered' | 'finished';
type Answer = { qid: string; answer: string; retry: false; ms: number } | { qid: string; rating: number; ms: number };

/**
 * One lesson of generic idlepage/1 cards. Choice cards are judged locally against the
 * server's `correct` (the server re-judges on submit); self cards are graded by the user,
 * and grades marked `again` come back later in the same lesson.
 */
export class StudySession {
  readonly lessonId = randomBytes(12).toString('hex');
  private queue: Question[];
  private position = 0;
  private shownAt: number;
  private picked?: string;
  private again = new Map<string, number>();
  private recorded: Answer[] = [];
  private correctCount = 0;
  phase: StudyPhase;
  constructor(readonly bank: string, readonly title: string, private readonly lesson: Lesson, private readonly now = () => Date.now()) {
    this.queue = [...lesson.questions];
    this.shownAt = now();
    this.phase = this.queue.length ? 'front' : 'finished';
  }
  get current(): Question | undefined { return this.queue[this.position]; }
  get index(): number { return Math.min(this.position + 1, this.queue.length); }
  get total(): number { return this.queue.length; }
  get answers(): readonly Answer[] { return this.recorded; }
  get choice(): { picked: string; correct: boolean } | undefined {
    const answer = this.current?.view.answer;
    return this.picked !== undefined && answer?.type === 'choice' ? { picked: this.picked, correct: this.picked === answer.correct } : undefined;
  }
  get score(): { correct: number; answered: number } {
    return { correct: this.correctCount, answered: this.recorded.filter(a => 'answer' in a).length };
  }
  private elapsed(): number { return Math.max(0, Math.min(600000, this.now() - this.shownAt)); }
  reveal(): boolean {
    if (this.phase !== 'front' || this.current?.view.answer.type !== 'self') return false;
    this.phase = 'revealed'; return true;
  }
  choose(id: string): boolean {
    const q = this.current;
    if (this.phase !== 'front' || q?.view.answer.type !== 'choice' || !q.view.answer.choices.some(c => c.id === id)) return false;
    this.picked = id; this.phase = 'answered';
    this.recorded.push({ qid: q.qid, answer: id, retry: false, ms: this.elapsed() });
    if (id === q.view.answer.correct) this.correctCount++;
    return true;
  }
  grade(rating: number): boolean {
    const q = this.current;
    if (this.phase !== 'revealed' || q?.view.answer.type !== 'self') return false;
    const grade = q.view.answer.grades.find(g => g.rating === rating);
    if (!grade) return false;
    this.recorded.push({ qid: q.qid, rating, ms: this.elapsed() });
    if (grade.again) {
      // Same spacing as the site's own cards: three cards later, then five.
      const times = this.again.get(q.qid) ?? 0;
      if (times < 6) {
        this.again.set(q.qid, times + 1);
        this.queue.splice(Math.min(this.queue.length, this.position + 1 + (times ? 5 : 3)), 0, q);
      }
    }
    this.step(); return true;
  }
  /** Leaves the feedback of an answered choice card. */
  advance(): boolean {
    if (this.phase !== 'answered') return false;
    this.step(); return true;
  }
  private step() {
    this.position++; this.picked = undefined; this.shownAt = this.now();
    this.phase = this.position < this.queue.length ? 'front' : 'finished';
  }
  /** Body for POST banks/{id}/results; undefined when nothing was answered yet. */
  submission(day: string): Record<string, unknown> | undefined {
    if (!this.recorded.length) return;
    return { ...this.lesson.echo, lesson_id: this.lessonId, day, answers: this.recorded };
  }
}
