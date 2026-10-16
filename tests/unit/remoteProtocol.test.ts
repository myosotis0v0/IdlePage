import assert from 'node:assert/strict';
import { test } from 'node:test';
import { banksForPage, siteLabel, parseAccount, parseBanks,parseDescriptor, parseLesson, parseUnits, parseView, samePath, serverAddress } from '../../src/domain/remoteProtocol';

const origin = 'https://study.example:8443';
const choice = { prompt: '几度？', audio: [{ label: '再听', src: 'banks/ear/audio/q1' }], answer: { type: 'choice', choices: [{ id: '7', label: '纯五度', detail: 'P5' }, { id: '12', label: '纯八度' }], correct: '7', reveal: 'A → E', audio: 'banks/ear/audio/q1?part=after' } };

test('practice page address selects only the banks declaring that page', () => {
  assert.deepEqual(serverAddress('https://study.example:8443/tools/music/ear-training'), { origin, home: '/.well-known/idlepage.json', page: '/tools/music/ear-training/' });
  assert.equal(serverAddress('https://study.example:8443/tools/language/vocab/index.html')?.page, '/tools/language/vocab/');
  assert.equal(serverAddress('https://study.example:8443/')?.page, undefined);
  const banks = parseBanks({ banks: [{ id: 'ear', title: '练耳', page: '/tools/music/ear-training/' }, { id: 'n2', title: 'N2', page: '/tools/language/vocab/' },
    { id: 'n3', title: 'N3', page: '/tools/language/vocab' }, { id: 'loose', title: '无页面' }, { id: 'bad', title: 'x', page: 'https://evil.example/' }] })!;
  assert.deepEqual(banksForPage(banks, '/tools/language/vocab/').map(b => b.id), ['n2', 'n3']);
  assert.deepEqual(banksForPage(banks, '/tools/music/ear-training/').map(b => b.id), ['ear']);
  assert.deepEqual(banksForPage(banks, '/tools/other/').map(b => b.id), []);
  // A server that declares no pages at all (older or page-less) offers every bank instead of nothing.
  assert.deepEqual(banksForPage([{ id: 'a', title: 'A', description: '', mode: '' }], '/tools/music/ear-training/').map(b => b.id), ['a']);
  assert.equal(banksForPage(banks, undefined).length, 5);
});

test('server address accepts a site or descriptor URL and refuses clear-text remote hosts', () => {
  assert.deepEqual(serverAddress('https://study.example:8443/'), { origin, home: '/.well-known/idlepage.json' });
  assert.deepEqual(serverAddress(' https://study.example:8443/custom/idle.json '), { origin, home: '/custom/idle.json' });
  assert.deepEqual(serverAddress('http://127.0.0.1:9000'), { origin: 'http://127.0.0.1:9000', home: '/.well-known/idlepage.json' });
  for (const bad of ['http://study.example', 'ftp://study.example', 'https://user:pw@study.example', 'not a url', '']) assert.equal(serverAddress(bad), undefined, bad);
});

test('paths stay on the server origin', () => {
  assert.equal(samePath(origin, 'banks/a', '/api/study/'), '/api/study/banks/a');
  assert.equal(samePath(origin, '/oauth2/start?rd=%2F'), '/oauth2/start?rd=%2F');
  for (const bad of ['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)', 42, '']) assert.equal(samePath(origin, bad), undefined, String(bad));
});

test('descriptor requires the protocol id and same-origin endpoints', () => {
  const address = { origin, home: '/.well-known/idlepage.json' };
  assert.deepEqual(parseDescriptor({ protocol: 'idlepage/1', name: '站点', login: '/login', logout: '/logout?rd=%2F', account: '/api/me', study: '/api/study' }, address),
    { ...address, name: '站点', login: '/login', logout: '/logout?rd=%2F', account: '/api/me', study: '/api/study/' });
  assert.equal(parseDescriptor({ protocol: 'idlepage/1', logout: 'https://evil.example/out' }, address), undefined);
  assert.equal(parseAccount({ id: 7, username: 'reader', display_name: '读者' }), '读者');
  assert.equal(parseAccount({ login: 'reader' }), 'reader');
  assert.equal(parseAccount({ id: 7 }), undefined);
  assert.equal(parseDescriptor({ protocol: 'idlepage/2', study: '/api/' }, address), undefined);
  assert.equal(parseDescriptor({ protocol: 'idlepage/1', study: 'https://evil.example/api/' }, address), undefined);
  assert.equal(parseDescriptor({ protocol: 'idlepage/1' }, address)?.name, '自定义网站', 'never fall back to the host');
});

test('banks without card faces and malformed entries are dropped', () => {
  assert.deepEqual(parseBanks({ banks: [{ id: 'jlpt-n2', title: 'N2', mode: 'srs', view: true }, { id: 'web-only', title: 'x', view: false }, { id: '../x', title: 'bad' }, { id: 'ok' }] }),
    [{ id: 'jlpt-n2', title: 'N2', description: '', mode: 'srs' }]);
  assert.equal(parseBanks({ items: [] }), undefined);
  assert.deepEqual(parseUnits({ units: [{ id: 'a', title: 'A', view: true }, { id: 'b', title: 'B', view: false }] }, { units: { a: { unlocked: false } } }),
    [{ id: 'a', title: 'A', group: undefined, view: true, unlocked: false }, { id: 'b', title: 'B', group: undefined, view: false, unlocked: undefined }]);
});

test('views are validated and audio resolves against the study root', () => {
  const view = parseView(choice, origin, '/api/study/');
  assert.equal(view?.audio[0].src, '/api/study/banks/ear/audio/q1');
  assert.equal(view?.answer.type === 'choice' && view.answer.audio, '/api/study/banks/ear/audio/q1?part=after');
  assert.equal(parseView({ ...choice, answer: { ...choice.answer, correct: 'missing' } }, origin, '/api/study/'), undefined);
  const self = parseView({ prompt: '就任', answer: { type: 'self', back: 'しゅうにん', grades: [{ rating: 1, label: '不认识', again: true }, { rating: 3, label: '认识', hint: '3 天' }], audio: 'banks/n2/speech/q1' } }, origin, '/api/study/');
  assert.deepEqual(self?.answer, { type: 'self', back: 'しゅうにん', grades: [{ rating: 1, label: '不认识', hint: undefined, again: true }, { rating: 3, label: '认识', hint: '3 天', again: false }], audio: '/api/study/banks/n2/speech/q1' });
  assert.equal(parseView({ prompt: 'x', audio: [{ label: 'evil', src: 'https://evil.example/a.wav' }], answer: choice.answer }, origin, '/')?.audio.length, 0);
});

test('lesson echoes only scalar lesson fields and skips unusable questions', () => {
  const lesson = parseLesson({ lesson: { unit: 'int', level: 2, set: null, answers: 'x', nested: { a: 1 } }, questions: [{ qid: 'abc', view: choice }, { qid: 'bad id', view: choice }, { qid: 'def', view: {} }] }, origin, '/api/study/');
  assert.deepEqual(lesson?.echo, { unit: 'int', level: 2, set: null });
  assert.deepEqual(lesson?.questions.map(q => q.qid), ['abc']);
});

test('configured practice URLs show a short name', () => {
  assert.equal(siteLabel('https://example.com/tools/music/ear-training/'), 'ear-training');
  assert.equal(siteLabel('https://example.com/tools/language/vocab'), 'vocab');
  assert.equal(siteLabel('https://example.com/practice/index.html'), 'index');
  assert.equal(siteLabel('https://example.com:8443/'), 'example.com');
  assert.equal(siteLabel('https://example.com/a-very-long-practice-page-name/'), 'a-very-long-pract…');
});
