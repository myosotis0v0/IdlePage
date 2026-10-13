import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { QidianAccessProbe } from '../../src/application/QidianAccessProbe';
import { parseObservation } from '../../src/domain/browserBridge';
const visible = { state: 'SiteContentVisible', pageKind: 'bookshelf', bodyCharacters: 1500, bookLinks: 1, verification: false, tooFrequent: false, captchaFrame: false };
const login = { ...visible, state: 'NeedsLogin', pageKind: 'login' };
const evidence = { ...visible, loginEvidence: 'bookshelf-content' };
function chapterSession() {
  const probe = new QidianAccessProbe();
  probe.restoreMetadata({ books: [{ id: '100', title: 'Fixture', url: 'https://www.qidian.com/book/100/' }], strategy: 'table', anchorCount: 1, truncated: false, pagination: 'not-detected', containerHints: [] },
    { bookId: '100', total: 2, declaredCount: 2, truncated: false, strategy: 'catalog-container', chapters: [1, 2].map(id => ({ id: String(id), title: 'Fixture', volume: '', payment: 'unknown', url: `https://www.qidian.com/chapter/100/${id}/` })) });
  probe.startChapterExtraction(); const first = probe.nextTask()!;
  probe.accept(first.id, { ...visible, pageKind: 'chapter' });
  probe.acceptChapter(first.id, { status: 'available', offset: 0, total: 4, text: 'body' });
  probe.startNextChapter(); return probe;
}
test('login preserves selected chapter and old body, resumes once with a new identity and discards partial chunks', () => {
  const probe = chapterSession(); const chapter = probe.nextTask()!;
  probe.accept(chapter.id, { ...visible, pageKind: 'chapter' });
  probe.acceptChapter(chapter.id, { status: 'available', offset: 0, total: 8, text: 'part' });
  probe.accept(chapter.id, login); const auth = probe.nextTask()!;
  assert.equal(auth.kind, 'login'); assert.equal(probe.getReadingChapter()?.text, 'body');
  probe.accept(auth.id, visible); assert.equal(probe.snapshot().phase, 'waiting-login');
  probe.accept(auth.id, { ...visible, pageKind: 'other' }); assert.equal(probe.nextTask()?.id, auth.id);
  probe.accept(auth.id, evidence); const resumed = probe.nextTask()!;
  assert.equal(resumed.url, chapter.url); assert.notEqual(resumed.id, chapter.id);
  assert.equal(probe.accept(auth.id, evidence), 'stale');
  assert.equal(probe.acceptChapter(chapter.id, { status: 'available', offset: 4, total: 8, text: 'late' }), 'stale');
  probe.accept(resumed.id, { ...visible, pageKind: 'chapter' });
  assert.equal(probe.acceptChapter(resumed.id, { status: 'available', offset: 0, total: 4, text: 'next' }), 'accepted');
  assert.equal(probe.snapshot().chapterNavigation.current, 2); assert.equal(probe.getReadingChapter()?.text, 'next');
});
test('cancellation, replacement, repeated login failure and login timeout cannot revive the saved target', () => {
  for (const action of ['cancel', 'replace', 'repeat', 'timeout']) {
    const probe = chapterSession(); const chapter = probe.nextTask()!;
    probe.acceptChapter(chapter.id, { status: 'unavailable', reason: 'needs-login' }); const auth = probe.nextTask()!;
    assert.equal(auth.kind, 'login');
    if (action === 'cancel') assert.equal(probe.cancel(), true);
    if (action === 'replace') probe.startBookshelfExtraction();
    if (action === 'timeout') assert.equal(probe.expireChapter(Date.now() + 600001), true);
    if (action === 'repeat') { probe.accept(auth.id, evidence); probe.accept(probe.nextTask()!.id, login); assert.equal(probe.snapshot().failure?.reason, 'login-failed'); }
    assert.equal(probe.accept(auth.id, evidence), 'stale'); assert.equal(probe.snapshot().recovery.waitingLogin, false);
    if (action !== 'replace') { assert.equal(probe.nextTask(), null); assert.equal(probe.getReadingChapter()?.text, 'body'); }
  }
});
test('all online task kinds stop on challenge or timeout; login-only verification remains manual', () => {
  for (const start of [(p: QidianAccessProbe) => p.restart(), (p: QidianAccessProbe) => p.startBookshelfExtraction(), (p: QidianAccessProbe) => p.startCatalogExtraction()]) {
    const probe = new QidianAccessProbe(); start(probe); const task = probe.nextTask()!;
    probe.accept(task.id, { ...visible, captchaFrame: true }); assert.equal(probe.nextTask(), null);
    assert.equal(probe.accept(task.id, evidence), 'stale'); start(probe);
    assert.equal(probe.expireChapter(Date.now() + 90001), true); assert.equal(probe.nextTask(), null);
  }
  const probe = chapterSession(); probe.accept(probe.nextTask()!.id, login); const task = probe.nextTask()!;
  probe.accept(task.id, { ...login, captchaFrame: true }); assert.equal(probe.nextTask()?.id, task.id);
  probe.accept(task.id, { ...login, tooFrequent: true }); assert.equal(probe.nextTask(), null);
});
test('positive login evidence is bounded, scoped to personal bookshelf and never overrides a challenge', async () => {
  const source = await readFile(new URL('../../browser-extension/login.js', import.meta.url), 'utf8');
  const bookshelf = await readFile(new URL('../../browser-extension/bookshelf.js', import.meta.url), 'utf8');
  const context: Record<string, any> = { URL, TextEncoder }; runInNewContext(bookshelf + source, context);
  const location = { hostname: 'my.qidian.com', pathname: '/bookcase/', href: 'https://my.qidian.com/bookcase/' };
  const check = (html: string, loc = location) => context.IdlePageLogin.evidence(parseHTML(`<html><body>${html}</body></html>`).document, loc);
  assert.equal(check('<p>Welcome</p><a href="https://www.qidian.com/book/100/">Recommendation</a>'), undefined);
  assert.equal(check('<div id="bookcaseList"><a href="https://www.qidian.com/book/100/">Fixture</a></div>'), 'bookshelf-content');
  assert.equal(check('<a href="https://passport.qidian.com/logout">Exit</a>'), 'signed-in-control');
  assert.equal(check('<a href="https://passport.qidian.com.evil.example/logout">Exit</a>'), undefined);
  assert.equal(check('<a href="https://passport.qidian.com/logout">Exit</a>', { ...location, hostname: 'www.qidian.com' }), undefined);
  assert.equal(parseObservation({ ...evidence, pageKind: 'chapter' }), undefined);
  assert.equal(parseObservation({ ...evidence, captchaFrame: true })?.state, 'AccessBlocked');
  assert.equal(parseObservation({ ...visible, bodyCharacters: 10, bookLinks: 0, loginEvidence: 'signed-in-control' })?.state, 'SiteContentVisible');
});

test('refresh failures preserve the last readable catalog/body and stale connection failures cannot stop replacements', () => {
  const probe = chapterSession(); probe.cancel();
  const oldBody = probe.getReadingChapter();
  probe.startCatalogExtraction(); const catalog = probe.nextTask()!;
  probe.startBookshelfExtraction(); const shelf = probe.nextTask()!;
  assert.equal(probe.failConnection(catalog.id), false); assert.equal(probe.isCurrentTask(shelf.id), true);
  assert.equal(probe.failConnection(shelf.id), true); assert.equal(probe.nextTask(), null);
  assert.deepEqual(probe.getReadingChapter(), oldBody);
  assert.equal(probe.startNextChapter(), 'started');
  assert.equal(probe.nextTask()?.url, 'https://www.qidian.com/chapter/100/2/');
});
