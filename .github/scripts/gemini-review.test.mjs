import assert from 'node:assert/strict';
import test from 'node:test';
import { addedLines, formatReview, parseReview, runReview, selectPatches } from './gemini-review.mjs';

const sha = 'a'.repeat(40);
const repository = 'example/rescate';
const file = { filename: 'api/src/example.ts', status: 'modified',
  patch: '@@ -10,3 +10,4 @@\n context\n-old\n+new\n+extra\n tail\n@@ -30 +31 @@\n-before\n+after' };
const finding = { path: file.filename, line: 11, severity: 'alta', body: 'Caso concreto de regresión.' };
const result = { summary: 'Revisión del diff recibido.', findings: [finding] };
const response = (value = result, reason = 'STOP') => ({ candidates: [{ finishReason: reason,
  content: { parts: [{ text: JSON.stringify(value) }] } }] });
const pr = { state: 'open', draft: false, changed_files: 1, title: 'Un cambio', body: 'Contexto',
  head: { sha, repo: { full_name: repository } } };

// The fake transport exercises the entire request-to-publication path without credentials.
function harness({ initial = pr, final = pr, reviews = [], files = [file], geminiStatus = 200,
  geminiResponse = response() } = {}) {
  const requests = [];
  const messages = [];
  let reads = 0;
  const options = { repository, prNumber: 135, expectedSha: sha, githubToken: 'github-test-token',
    apiKey: 'gemini-test-key', rules: 'Reglas de prueba', report: (message) => messages.push(message),
    fetchImpl: async (url, init) => {
      requests.push({ url, ...init });
      const reply = (value, status = 200) => ({ ok: status >= 200 && status < 300,
        status, json: async () => value });
      if (url.includes('generativelanguage.googleapis.com')) return reply(geminiResponse, geminiStatus);
      if (init.method === 'POST') return reply({ id: 42 });
      if (url.includes('/reviews?')) return reply(reviews);
      if (url.includes('/files?')) return reply(files);
      return reply(reads++ === 0 ? initial : final);
    } };
  return { options, requests, messages, posts: () => requests.filter((r) => r.method === 'POST' && r.url.endsWith('/reviews')),
    modelCalls: () => requests.filter((r) => r.url.includes('generativelanguage.googleapis.com')) };
}

test('diff positions count context, removals and separate hunks correctly', () => {
  assert.deepEqual([...addedLines(file.patch)], [11, 12, 31]);
  assert.deepEqual([...addedLines('@@ -0,0 +1,2 @@\n+one\n+two')], [1, 2]);
});

test('patch budget omits whole large patches and binary files, preserving later small files', () => {
  const huge = { filename: 'package-lock.json', patch: 'x'.repeat(1000) };
  const binary = { filename: 'image.png' };
  const selected = selectPatches([huge, binary, file], 400);
  assert.deepEqual(selected.included, [file]);
  assert.deepEqual(selected.omitted, ['package-lock.json', 'image.png']);
});

test('incomplete output and invalid model locations never become findings', () => {
  assert.throws(() => parseReview(response(result, 'MAX_TOKENS'), [file]), /completa/);
  for (const invalid of [{ line: 10 }, { line: 13 }, { line: '11' },
    { path: 'not-in-pr.ts' }, { severity: 'baja' }, { body: '' }]) {
    assert.throws(() => parseReview(response({ ...result, findings: [{ ...finding, ...invalid }] }), [file]), /inválido/);
  }
  assert.deepEqual(parseReview(response(), [file]), result);
});

test('review body links to the exact commit and discloses omitted files', () => {
  const body = formatReview(result, { included: [file], omitted: ['image.png'] }, repository, sha);
  assert.ok(body.includes(`/blob/${sha}/${file.filename}#L11`));
  assert.match(body, /Cobertura parcial/);
  assert.match(body, /image.png/);
});

test('publishes one COMMENT review for the expected SHA and separates provider credentials', async () => {
  const h = harness();
  await runReview(h.options);
  assert.equal(h.modelCalls().length, 1);
  assert.equal(h.posts().length, 1);
  assert.deepEqual(Object.keys(JSON.parse(h.posts()[0].body)).sort(), ['body', 'commit_id', 'event']);
  assert.equal(JSON.parse(h.posts()[0].body).commit_id, sha);
  assert.equal(JSON.parse(h.posts()[0].body).event, 'COMMENT');
  for (const request of h.requests) {
    if (request.url.startsWith('https://api.github.com/')) {
      assert.equal(request.headers['x-goog-api-key'], undefined);
      assert.ok(!JSON.stringify(request).includes('gemini-test-key'));
    } else {
      assert.equal(request.headers.authorization, undefined);
      assert.ok(!JSON.stringify(request).includes('github-test-token'));
      assert.equal(JSON.parse(request.body).generationConfig.responseMimeType, 'application/json');
      assert.equal(JSON.parse(request.body).tools, undefined);
    }
    assert.equal(request.redirect, 'error');
  }
});

for (const [name, change] of [['draft', { draft: true }], ['closed', { state: 'closed' }],
  ['fork', { head: { sha, repo: { full_name: 'outsider/rescate' } } }],
  ['replaced commit', { head: { ...pr.head, sha: 'b'.repeat(40) } }]]) {
  test(`${name} is skipped before contacting Gemini`, async () => {
    const h = harness({ initial: { ...pr, ...change } });
    await runReview(h.options);
    assert.equal(h.modelCalls().length, 0);
    assert.equal(h.posts().length, 0);
    assert.match(h.messages[0], /Omitido/);
  });
}

test('a new push during generation discards the result', async () => {
  const h = harness({ final: { ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } } });
  await runReview(h.options);
  assert.equal(h.modelCalls().length, 1);
  assert.equal(h.posts().length, 0);
  assert.match(h.messages[0], /descartado/);
});

test('rerunning a reviewed SHA consumes no additional Gemini quota', async () => {
  const h = harness({ reviews: [{ user: { login: 'github-actions[bot]' }, commit_id: sha,
    body: `<!-- gemini-pr-review:${sha} -->` }] });
  await runReview(h.options);
  assert.equal(h.modelCalls().length, 0);
  assert.equal(h.posts().length, 0);
});

test('missing secret fails explicitly without publishing', async () => {
  const h = harness();
  await assert.rejects(runReview({ ...h.options, apiKey: '' }), /Falta el secreto GEMINI_API_KEY/);
  assert.equal(h.modelCalls().length, 0);
  assert.equal(h.posts().length, 0);
});

for (const status of [400, 403, 429, 503]) {
  test(`Gemini HTTP ${status} fails without a fake review or automatic quota-consuming retries`, async () => {
    const h = harness({ geminiStatus: status });
    await assert.rejects(runReview(h.options), new RegExp(`HTTP ${status}`));
    assert.equal(h.modelCalls().length, 1);
    assert.equal(h.posts().length, 0);
  });
}

test('malformed model output never posts a review', async () => {
  const h = harness({ geminiResponse: response({ ...result, findings: [{ ...finding, line: 999 }] }) });
  await assert.rejects(runReview(h.options), /inválido/);
  assert.equal(h.posts().length, 0);
});

test('binary-only or oversized-only PR fails instead of claiming a clean review', async () => {
  const h = harness({ files: [{ filename: 'binary.png' }] });
  await assert.rejects(runReview(h.options), /No hay diffs revisables/);
  assert.equal(h.modelCalls().length, 0);
  assert.equal(h.posts().length, 0);
});

test('a valid review with no findings is published with its limited scope', async () => {
  const h = harness({ geminiResponse: response({ summary: 'Solo se recibió un diff.', findings: [] }) });
  await runReview(h.options);
  assert.equal(h.posts().length, 1);
  assert.match(JSON.parse(h.posts()[0].body).body, /No se identificaron defectos concretos en los diffs enviados/);
});
