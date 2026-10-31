import assert from 'node:assert/strict';
import test from 'node:test';
import { MODEL, marker, parseReview, deduplicate, formatReview, runReview } from './gemini-review.mjs';
import { patchLines } from './review-context.mjs';

const sha = 'a'.repeat(40);
const base = 'b'.repeat(40);
const repository = 'example/rescate';
const file = { filename: 'api/src/example.ts', status: 'modified',
  patch: '@@ -10,3 +10,4 @@\n context\n-old\n+new\n+extra\n tail\n@@ -30 +31 @@\n-before\n+after' };
const evidence = { path: file.filename, side: 'RIGHT', line: 11, quote: 'new' };
const finding = { path: file.filename, side: 'RIGHT', line: 11, severity: 'media',
  title: 'Error concreto', body: 'Impacto y corrección concreta.', scenario: 'Una entrada reproduce el error.', confidence: 0.95, evidence };
const review = (findings = [], files = [file]) => ({ reviewedFiles: [...new Set(files.map(file => file.filename))], findings, limitations: [] });
const response = (value, finishReason = 'STOP') => ({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(value) }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 10 } });
const largeFile = filename => ({ filename, status: 'added', patch: '@@ -0,0 +1,200 @@\n' + Array.from({ length: 200 }, (_, i) => `+const v${i} = '${'x'.repeat(180)}'`).join('\n') });

function harness({ files = [file], reviews = [], statuses = [200], model, openRouterApiKey, openRouterResponses = [],
  geminiReplies = [], openRouterReplies = [], initial = {}, sourceFiles = {}, patches = {}, sourceError = false, planOptions } = {}) {
  const requests = [], messages = [], waits = [], artifacts = [];
  const pr = { state: 'open', draft: false, changed_files: files.length, title: 'Cambio', body: 'Descripción del autor',
    head: { sha, repo: { full_name: repository } }, base: { sha: base }, ...initial };
  let current = pr;
  let modelCalls = 0;
  let openRouterCalls = 0;
  const options = { repository, prNumber: 147, expectedSha: sha, githubToken: 'github-test-token', apiKey: 'gemini-test-key',
    openRouterApiKey,
    rules: 'Reglas confiables', report: message => messages.push(message), saveResult: result => artifacts.push(result),
    sleepImpl: async delay => { waits.push(delay); }, planOptions,
    loadSource: async () => {
      if (sourceError) throw new Error('Faltan objetos Git.');
      return { baseSha: base, patch: async file => patches[file.filename] ?? file.patch,
        read: async filename => sourceFiles[filename] ?? null };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, ...init });
      const reply = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
      if (url.includes('generativelanguage.googleapis.com')) {
        const index = modelCalls++;
        if (geminiReplies[index] !== undefined) {
          if (geminiReplies[index] instanceof Error) throw geminiReplies[index];
          return geminiReplies[index];
        }
        const status = statuses[Math.min(index, statuses.length - 1)];
        if (status instanceof Error) throw status;
        const payload = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text);
        const result = model ? model(payload, index) : review([], payload.files);
        return reply(response(result), status);
      }
      if (url.includes('openrouter.ai')) {
        const index = openRouterCalls++;
        if (openRouterReplies[index] !== undefined) {
          if (openRouterReplies[index] instanceof Error) throw openRouterReplies[index];
          return openRouterReplies[index];
        }
        const payload = JSON.parse(JSON.parse(init.body).messages[1].content);
        const result = openRouterResponses[index] ?? review([], payload.files);
        return reply({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }],
          model: 'test/free-model', usage: { prompt_tokens: 100, completion_tokens: 20,
            completion_tokens_details: { reasoning_tokens: 0 } } });
      }
      if (init.method === 'POST') return reply({ id: 42 });
      if (url.includes('/reviews?')) return reply(reviews);
      if (url.includes('/files?')) {
        const page = Number(new URL(url).searchParams.get('page'));
        return reply(files.slice((page - 1) * 100, page * 100));
      }
      return reply(current);
    } };
  return { options, requests, messages, waits, artifacts, setCurrent: change => { current = { ...pr, ...change }; },
    posts: () => requests.filter(r => r.method === 'POST' && r.url.endsWith('/reviews')),
    models: () => requests.filter(r => r.url.includes('generativelanguage.googleapis.com')),
    openRouterRequests: () => requests.filter(r => r.url.includes('openrouter.ai')),
    openRouterCalls: () => openRouterCalls };
}

test('positions distinguish additions, removals and context across hunks', () => {
  assert.deepEqual([...patchLines(file.patch, 'RIGHT', true).keys()], [11, 12, 31]);
  assert.deepEqual([...patchLines(file.patch, 'LEFT', true).keys()], [11, 30]);
  assert.equal(patchLines(file.patch).get(13), 'tail');
});

test('schema, coverage, confidence, changed locations and source quotes are validated', () => {
  assert.deepEqual(parseReview(response(review([finding])), [file]), review([finding]));
  assert.throws(() => parseReview(response(review(), 'MAX_TOKENS'), [file]), /completa/);
  assert.throws(() => parseReview(response(null), [file]), /formato/);
  for (const invalid of [{ line: 10 }, { line: '11' }, { path: 'elsewhere.ts' }, { side: 'other' },
    { severity: 'baja' }, { confidence: 0.84 }, { confidence: null }, { title: '' }, { scenario: '' },
    { evidence: { ...evidence, quote: 'inventado' } }, { evidence: { ...evidence, line: 12 } }, { evidence: null }]) {
    assert.throws(() => parseReview(response(review([{ ...finding, ...invalid }])), [file]), /inválido/);
  }
  for (const reviewedFiles of [[], [file.filename, file.filename], ['missing.ts']]) {
    assert.throws(() => parseReview(response({ ...review(), reviewedFiles }), [file]), /cobertura/);
  }
});

test('numbered dependency context can support a finding, but unseen code cannot', () => {
  const dependency = { path: 'api/src/domain/check.ts', side: 'RIGHT', line: 40, quote: 'return false' };
  const result = response(review([{ ...finding, evidence: dependency }]));
  assert.throws(() => parseReview(result, [file]), /evidencia/);
  assert.equal(parseReview(result, [file], { snippets: [{ path: dependency.path, startLine: 40, lines: ['return false'] }] }).findings.length, 1);
});

test('deleted lines in renamed files point to their old path', () => {
  const renamed = { ...file, filename: 'api/src/new.ts', previous_filename: file.filename };
  const removed = { ...finding, side: 'LEFT', evidence: { ...evidence, side: 'LEFT', quote: 'old' } };
  assert.equal(parseReview(response(review([removed], [renamed])), [renamed]).findings[0].side, 'LEFT');
});

test('findings are deduplicated and sorted by severity and confidence', () => {
  const high = { ...finding, line: 12, severity: 'alta' };
  assert.deepEqual(deduplicate([finding, { ...finding, confidence: 0.9 }, high]), [high, finding]);
});

test('a valid finding is published in one pass with source evidence and usage', async () => {
  const h = harness({ model: payload => review([finding], payload.files) });
  const result = await runReview(h.options);
  assert.equal(h.models().length, 1);
  assert.equal(h.posts().length, 1);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0].evidence, evidence);
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(result.usage.thinkingTokens, 10);
  assert.equal(h.artifacts.length, 1);
  assert.match(JSON.parse(h.posts()[0].body).body, /Archivos completos: 1\/1/);
  assert.ok(h.models()[0].url.endsWith(`/models/${MODEL}:generateContent`));
  for (const request of h.requests) {
    assert.equal(request.redirect, 'error');
    if (request.url.startsWith('https://api.github.com/')) {
      assert.equal(request.headers['x-goog-api-key'], undefined);
      assert.ok(!JSON.stringify(request).includes('gemini-test-key'));
    } else {
      assert.equal(request.headers.authorization, undefined);
      assert.ok(!JSON.stringify(request).includes('github-test-token'));
      const body = JSON.parse(request.body);
      assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'high');
      assert.equal(body.tools, undefined);
    }
  }
});

test('a clean batch needs only one call and never claims a second pass', async () => {
  const h = harness();
  assert.equal((await runReview(h.options)).findings.length, 0);
  assert.equal(h.models().length, 1);
  assert.doesNotMatch(JSON.parse(h.posts()[0].body).body, /segunda pasada/);
});

test('local Git patches replace absent or truncated GitHub patches', async () => {
  const h = harness({ files: [{ ...file, patch: undefined }], patches: { [file.filename]: file.patch } });
  assert.equal((await runReview(h.options)).coverage.reviewedFiles.length, 1);
  const payload = JSON.parse(JSON.parse(h.models()[0].body).contents[0].parts[0].text);
  assert.ok(payload.files[0].patch.includes('+extra'));
});

test('large PRs review every batch; source files are not displaced by scripts', async () => {
  const files = ['api/scripts/a.mjs', 'api/scripts/b.mjs', 'api/src/http/panel.ts', 'api/src/infrastructure/panel.ts', 'web/src/pages/Panel.tsx'].map(largeFile);
  const h = harness({ files });
  const result = await runReview(h.options);
  assert.equal(result.coverage.reviewedFiles.length, files.length);
  assert.ok(result.coverage.totalBatches > 1);
  assert.equal(result.coverage.completedBatches, result.coverage.totalBatches);
  const payload = JSON.parse(JSON.parse(h.models()[0].body).contents[0].parts[0].text);
  assert.ok(payload.files[0].filename.startsWith('api/src/'));
});

test('a later quota failure preserves completed batches and identifies the pending file', async () => {
  const files = [largeFile('api/src/a.ts'), largeFile('api/src/z.ts')];
  const h = harness({ files, statuses: [200, 429] });
  await assert.rejects(runReview(h.options), /429/);
  assert.equal(h.models().length, 2);
  assert.equal(h.artifacts[0].coverage.completedBatches, 1);
  assert.deepEqual(h.artifacts[0].coverage.reviewedFiles, [files[0].filename]);
  assert.equal(h.artifacts[0].coverage.pending[0].path, files[1].filename);
});

test('batch cap is visible and never produces a complete marker', async () => {
  const h = harness({ files: [largeFile('api/src/a.ts'), largeFile('web/src/z.ts')], planOptions: { maxBatches: 1 } });
  await assert.rejects(runReview(h.options), /parcial/);
  assert.equal(h.artifacts[0].complete, false);
  assert.match(JSON.parse(h.posts()[0].body).body, /límite de lotes/);
});

for (const status of [400, 403, 429]) test(`HTTP ${status} is not retried or presented as a clean review`, async () => {
  const h = harness({ statuses: [status] });
  await assert.rejects(runReview(h.options), new RegExp(`HTTP ${status}`));
  assert.equal(h.models().length, 1);
  assert.deepEqual(h.waits, []);
  assert.equal(h.artifacts[0].complete, false);
});

for (const status of [500, 502, 503, 504]) test(`HTTP ${status} retries with backoff and fresh signals`, async () => {
  const h = harness({ statuses: [status, status, 200] });
  await runReview(h.options);
  assert.deepEqual(h.waits, [10_000, 20_000]);
  assert.equal(h.models().length, 3);
  assert.equal(new Set(h.models().map(request => request.signal)).size, 3);
});

test('persistent timeouts or service failures stop after three requests', async () => {
  for (const status of [new DOMException('timeout', 'TimeoutError'), 503]) {
    const h = harness({ statuses: [status] });
    await assert.rejects(runReview(h.options), /conexión|HTTP 503/);
    assert.equal(h.models().length, 3);
    assert.equal(h.artifacts[0].complete, false);
  }
});

test('OpenRouter retries one invalid finding with corrective validation feedback', async () => {
  const invalid = review([{ ...finding, evidence: { ...evidence, quote: 'cita inventada' } }]);
  const h = harness({ statuses: [401], openRouterApiKey: 'openrouter-test-key', openRouterResponses: [invalid, review()] });
  const result = await runReview(h.options);
  assert.equal(result.complete, true);
  assert.equal(h.models().length, 1);
  assert.equal(h.openRouterCalls(), 2);
  assert.equal(result.usage.requests, 3);
  assert.equal(result.usage.unknownRequests, 1);
  assert.deepEqual(result.modelsUsed, ['OpenRouter Free · test/free-model']);
  const correction = JSON.parse(h.openRouterRequests()[1].body).messages[0].content;
  assert.match(correction, /REINTENTO CORRECTIVO/);
  assert.match(correction, /hallazgo inválido/);
  assert.match(h.messages.join('\n'), /solicitando una corrección/);
});

test('the total time limit stops before starting a model request', async () => {
  const h = harness();
  let calls = 0;
  await assert.rejects(runReview({ ...h.options, now: () => calls++ === 0 ? 0 : 20 * 60_000 }), /tiempo máximo total/);
  assert.equal(h.models().length, 0);
});

for (const [name, change] of [['draft', { draft: true }], ['closed', { state: 'closed' }],
  ['fork', { head: { sha, repo: { full_name: 'other/repo' } } }], ['replaced', { head: { sha: 'c'.repeat(40), repo: { full_name: repository } } }]]) {
  test(`${name} is skipped before loading Git or calling Gemini`, async () => {
    const h = harness({ initial: change, sourceError: true });
    await runReview(h.options);
    assert.equal(h.models().length, 0);
    assert.equal(h.posts().length, 0);
  });
}

test('a history-only PR is skipped without keys, Git, model requests or comments', async () => {
  for (const apiKey of [undefined, 'gemini-test-key']) {
    const h = harness({ files: [], sourceError: true });
    await runReview({ ...h.options, apiKey, openRouterApiKey: undefined });
    assert.equal(h.requests.length, 1);
    assert.equal(h.models().length, 0);
    assert.equal(h.openRouterRequests().length, 0);
    assert.equal(h.posts().length, 0);
    assert.equal(h.artifacts.length, 0);
    assert.match(h.messages.at(-1), /Omitido: PR sin cambios de archivos/);
  }
});

test('head or base movement during generation discards the result', async () => {
  for (const change of [{ head: { sha: 'c'.repeat(40), repo: { full_name: repository } } }, { base: { sha: 'd'.repeat(40) } }]) {
    const h = harness({ model: payload => { h.setCurrent(change); return review([], payload.files); } });
    await runReview(h.options);
    assert.equal(h.models().length, 1);
    assert.equal(h.posts().length, 0);
    assert.match(h.messages.at(-1), /descartado/);
  }
});

test('a PR closed during backoff stops before another request', async () => {
  const h = harness({ statuses: [503, 200] });
  await runReview({ ...h.options, sleepImpl: async () => h.setCurrent({ state: 'closed' }) });
  assert.equal(h.models().length, 1);
  assert.equal(h.posts().length, 0);
});

test('only a complete marker for this version, head, base and bot suppresses duplicate work', async () => {
  const complete = { user: { login: 'github-actions[bot]' }, commit_id: sha, body: marker(sha, base, true) };
  const h = harness({ reviews: [complete] });
  await runReview(h.options);
  assert.equal(h.models().length, 0);
  for (const review of [{ ...complete, body: marker(sha, base, false) }, { ...complete, user: { login: 'someone' } },
    { ...complete, body: marker(sha, 'e'.repeat(40), true) }, { ...complete, body: `<!-- gemini-pr-review:${sha} -->` }]) {
    const rerun = harness({ reviews: [review] });
    await runReview(rerun.options);
    assert.equal(rerun.models().length, 1);
  }
});

test('missing key, incomplete file enumeration and unavailable Git never consume model quota', async () => {
  const missing = harness();
  await assert.rejects(runReview({ ...missing.options, apiKey: '' }), /GEMINI_API_KEY/);
  const incomplete = harness({ initial: { changed_files: 2 } });
  await assert.rejects(runReview(incomplete.options), /lista de archivos/);
  const git = harness({ sourceError: true });
  await assert.rejects(runReview(git.options), /objetos Git/);
  for (const h of [missing, incomplete, git]) assert.equal(h.models().length, 0);
});

test('file pagination includes all pages', async () => {
  const files = Array.from({ length: 101 }, (_, i) => ({ ...file, filename: `api/src/f${i}.ts` }));
  const h = harness({ files });
  assert.equal((await runReview(h.options)).coverage.reviewedFiles.length, 101);
  assert.equal(h.requests.filter(request => request.url.includes('/files?')).length, 2);
});

test('review bodies link deleted code to merge-base and escape untrusted Markdown', () => {
  const result = { sha, baseSha: base, complete: false, coverage: { reviewedFiles: [], totalFiles: 1, completedBatches: 0,
    totalBatches: 1, pending: [{ path: 'image.png', reason: 'Binario' }], contextFiles: [], limitedContextFiles: [] },
    findings: [{ ...finding, side: 'LEFT', title: '<img> @someone [link](evil)' }], limitations: [] };
  const body = formatReview(result, repository);
  assert.ok(body.includes(`/blob/${base}/`));
  assert.ok(body.includes('&lt;img&gt;'));
  assert.ok(!body.includes('@someone'));
  assert.ok(!body.includes('[link](evil)'));
  assert.ok(body.indexOf('REVISIÓN INCOMPLETA') < body.indexOf('&lt;img&gt;'));
});

test('mixed binary and text changes retain the exclusion and stay incomplete', async () => {
  const h = harness({ files: [file, { filename: 'image.png', patch: 'Binary files differ' }] });
  await assert.rejects(runReview(h.options), /parcial/);
  assert.equal(h.artifacts[0].coverage.pending[0].path, 'image.png');
  assert.equal(h.artifacts[0].coverage.reviewedFiles.length, 1);
  const binary = harness({ files: [{ filename: 'image.png' }] });
  await assert.rejects(runReview(binary.options), /No hay diffs/);
  assert.equal(binary.models().length, 0);
});

test('invalid model output is accounted for without retaining prompts or credentials', async () => {
  const h = harness({ model: () => ({ reviewedFiles: [], findings: [], limitations: [] }) });
  const telemetry = [];
  await assert.rejects(runReview({ ...h.options, saveUsage: data => telemetry.push(structuredClone(data)) }), /cobertura/);
  assert.equal(telemetry[0].usage.unknownRequests, 1);
  assert.equal(telemetry.at(-1).usage.unknownRequests, 0);
  assert.equal(telemetry.at(-1).usage.inputTokens, 300);
  assert.ok(!JSON.stringify([h.messages, h.artifacts, telemetry]).includes('gemini-test-key'));
  assert.ok(!JSON.stringify(telemetry).includes(file.patch));
});

test('usage remains available when a generated response is discarded after a new push', async () => {
  const h = harness({ model: payload => {
    h.setCurrent({ head: { sha: 'c'.repeat(40), repo: { full_name: repository } } });
    return review([], payload.files);
  } });
  const telemetry = [];
  await runReview({ ...h.options, saveUsage: data => telemetry.push(structuredClone(data)) });
  assert.equal(h.posts().length, 0);
  assert.equal(telemetry.at(-1).usage.inputTokens, 100);
});

test('the GitHub body stays bounded and the artifact retains excess findings', () => {
  const result = { sha, baseSha: base, complete: false, coverage: { reviewedFiles: [], totalFiles: 100,
    completedBatches: 0, totalBatches: 10, pending: Array.from({ length: 100 }, () => ({ path: '&'.repeat(1000), reason: '&'.repeat(600) })),
    contextFiles: [], limitedContextFiles: [] }, limitations: Array(100).fill('&'.repeat(500)),
    findings: Array.from({ length: 128 }, (_, i) => ({ ...finding, line: i + 1, body: '&'.repeat(1800) })) };
  const body = formatReview(result, repository);
  assert.ok(body.length < 60_000);
  assert.match(body, /hallazgos adicionales/);
  assert.match(body, /pendientes figuran en el artefacto/);
  assert.equal(result.findings.length, 128);
});

test('unknown model fields cannot leak raw responses into validated artifacts', () => {
  const tainted = { ...finding, rawPrompt: 'must not be retained', evidence: { ...evidence, rawResponse: 'must not be retained' } };
  const parsed = parseReview(response({ ...review([tainted]), rawPrompt: 'must not be retained' }), [file]);
  assert.ok(!JSON.stringify(parsed).includes('must not be retained'));

});

test('Gemini retries unreadable HTTP bodies and invalid review JSON with corrective feedback', async () => {
  const h = harness({ geminiReplies: [new Response('<html>upstream unavailable</html>'),
    new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{broken' }] } }] }))] });
  const result = await runReview(h.options);
  assert.equal(result.complete, true);
  assert.equal(h.models().length, 3);
  assert.deepEqual(h.waits, [10_000, 20_000]);
  assert.match(JSON.parse(h.models()[1].body).systemInstruction.parts[0].text, /REINTENTO CORRECTIVO.*JSON ilegible/);
  assert.match(JSON.parse(h.models()[2].body).systemInstruction.parts[0].text, /JSON de revisión válido/);
  assert.equal(result.usage.unknownRequests, 2);
});

test('PR172 regression: the fallback retries an invalid finding, then unreadable JSON, then succeeds', async () => {
  const invalid = review([{ ...finding, evidence: { ...evidence, quote: 'cita inventada' } }]);
  const h = harness({ statuses: [401], openRouterApiKey: 'openrouter-test-key', openRouterResponses: [invalid],
    openRouterReplies: [undefined, new Response('upstream returned no JSON')] });
  const result = await runReview(h.options);
  assert.equal(result.complete, true);
  assert.equal(h.openRouterCalls(), 3);
  assert.equal(result.usage.requests, 4);
  assert.equal(result.usage.unknownRequests, 2);
  assert.deepEqual(result.diagnostics.map(item => item.provider), ['Gemini', 'OpenRouter', 'OpenRouter']);
  assert.match(result.diagnostics[0].reason, /HTTP 401/);
  assert.match(result.diagnostics[1].reason, /hallazgo inválido/);
  assert.match(result.diagnostics[2].reason, /JSON ilegible/);
});

for (const fault of ['timeout', 'connection', 'body', 'http', 'incomplete']) test(`OpenRouter retries ${fault} errors`, async () => {
  const replies = {
    timeout: () => new DOMException('timeout', 'TimeoutError'),
    connection: () => new TypeError('fetch failed'),
    body: () => ({ ok: true, json: async () => { throw new DOMException('body aborted', 'AbortError'); } }),
    http: () => new Response('{}', { status: 503 }),
    incomplete: () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }],
      usage: { prompt_tokens: 50, completion_tokens: 10 } })),
  };
  const h = harness({ openRouterApiKey: 'openrouter-test-key', openRouterReplies: [replies[fault]()] });
  const result = await runReview({ ...h.options, apiKey: undefined });
  assert.equal(result.complete, true);
  assert.equal(h.models().length, 0);
  assert.equal(h.openRouterCalls(), 2);
  assert.deepEqual(h.waits, [10_000]);
  assert.equal(new Set(h.openRouterRequests().map(request => request.signal)).size, 2);
  if (fault === 'incomplete') {
    assert.equal(result.usage.unknownRequests, 0);
    assert.equal(result.usage.inputTokens, 150);
    assert.equal(result.usage.outputTokens, 30);
  }
});

test('failed providers retain both diagnoses without retaining raw exceptions or credentials', async () => {
  const h = harness({ statuses: [403], openRouterApiKey: 'openrouter-test-key',
    openRouterReplies: Array.from({ length: 3 }, () => new TypeError('openrouter-test-key github-test-token secret request body')) });
  await assert.rejects(runReview(h.options), /Gemini devolvió HTTP 403.*OpenRouter: fallo de conexión/);
  assert.equal(h.models().length, 1);
  assert.equal(h.openRouterCalls(), 3);
  assert.equal(h.posts().length, 1);
  assert.equal(h.artifacts[0].diagnostics.length, 4);
  assert.doesNotMatch(JSON.stringify([h.artifacts, h.messages, JSON.parse(h.posts()[0].body)]),
    /openrouter-test-key|github-test-token|secret request body/);
});

test('a permanent Gemini failure is not repeated for every batch while the fallback completes the review', async () => {
  const files = ['api/src/a.ts', 'api/src/b.ts', 'api/src/c.ts'].map(largeFile);
  const h = harness({ files, statuses: [429], openRouterApiKey: 'openrouter-test-key' });
  const result = await runReview(h.options);
  assert.equal(result.complete, true);
  assert.equal(h.models().length, 1);
  assert.equal(h.openRouterCalls(), result.coverage.totalBatches);
  assert.equal(result.diagnostics.length, 1);
});

test('a first or middle batch failure still publishes findings from later batches', async () => {
  const files = ['api/src/a.ts', 'api/src/b.ts', 'api/src/c.ts'].map(largeFile);
  for (const failedIndex of [0, 1]) {
    const statuses = failedIndex === 0 ? [503, 503, 503, 200, 200] : [200, 503, 503, 503, 200];
    const h = harness({ files, statuses, model: payload => review([{ ...finding, path: payload.files[0].filename, line: 1,
      evidence: { path: payload.files[0].filename, side: 'RIGHT', line: 1, quote: 'const v0' } }], payload.files) });
    await assert.rejects(runReview(h.options), /HTTP 503/);
    const result = h.artifacts[0];
    assert.equal(result.complete, false);
    assert.equal(result.coverage.totalBatches, 3);
    assert.equal(result.coverage.completedBatches, 2);
    assert.deepEqual(result.coverage.pending.map(item => item.path), [files[failedIndex].filename]);
    assert.equal(result.coverage.reviewedFiles.length, 2);
    assert.equal(result.findings.length, 2);
    assert.ok(result.findings.some(item => item.path === files[2].filename));
    assert.equal(h.posts().length, 1);
    assert.match(JSON.parse(h.posts()[0].body).body, /REVISIÓN INCOMPLETA/);
    assert.match(JSON.parse(h.posts()[0].body).body, /api\/src\/c.ts/);
  }
});

test('one failed fragment keeps the file pending even when later fragments complete', async () => {
  const h = harness({ files: [largeFile('api/src/a.ts')], statuses: [503, 503, 503, 200], planOptions: { budget: 20_000 } });
  await assert.rejects(runReview(h.options), /HTTP 503/);
  const result = h.artifacts[0];
  assert.ok(result.coverage.completedBatches > 0);
  assert.deepEqual(result.coverage.reviewedFiles, []);
  assert.deepEqual(result.coverage.pending.map(item => item.path), ['api/src/a.ts']);
});

test('deadline stops further calls and backoff while preserving a partial report', async () => {
  const files = ['api/src/a.ts', 'api/src/b.ts'].map(largeFile);
  const h = harness({ files, statuses: [503] });
  let currentTime = 0;
  const originalFetch = h.options.fetchImpl;
  await assert.rejects(runReview({ ...h.options, now: () => currentTime, fetchImpl: async (url, init) => {
    const reply = await originalFetch(url, init);
    if (url.includes('generativelanguage')) currentTime = 20 * 60_000 - 20_000;
    return reply;
  } }), /tiempo máximo total/);
  assert.equal(h.models().length, 1);
  assert.deepEqual(h.waits, []);
  assert.equal(h.artifacts[0].coverage.pending.length, 2);
  assert.equal(h.posts().length, 1);
});

test('the comment shows at most five findings and keeps all validated findings in the artifact', async () => {
  const files = ['api/src/a.ts', 'api/src/b.ts'].map(largeFile);
  const h = harness({ files, model: payload => review(Array.from({ length: 5 }, (_, index) => ({ ...finding,
    title: `Defecto ${payload.part}-${index}`, path: payload.files[0].filename, line: index + 1,
    evidence: { path: payload.files[0].filename, side: 'RIGHT', line: index + 1, quote: `const v${index}` },
  })), payload.files) });
  const result = await runReview(h.options);
  assert.equal(result.findings.length, 10);
  assert.equal((JSON.parse(h.posts()[0].body).body.match(/\*\*media ·/g) ?? []).length, 5);
  assert.match(JSON.parse(h.posts()[0].body).body, /5 hallazgos adicionales/);
});

test('a complete review from version 2 does not suppress the simplified reviewer', async () => {
  const h = harness({ reviews: [{ user: { login: 'github-actions[bot]' }, commit_id: sha,
    body: `<!-- gemini-pr-review:v2:${sha}:${base}:complete -->` }] });
  await runReview(h.options);
  assert.equal(h.models().length, 1);
});

for (const status of [401, 403, 429]) test(`OpenRouter HTTP ${status} disables repeated calls and publishes an incomplete review`, async () => {
  const h = harness({ files: ['api/src/a.ts', 'api/src/b.ts'].map(largeFile), openRouterApiKey: 'openrouter-test-key',
    openRouterReplies: [new Response('{}', { status })] });
  await assert.rejects(runReview({ ...h.options, apiKey: undefined }), new RegExp(`OpenRouter devolvió HTTP ${status}`));
  assert.equal(h.openRouterCalls(), 1);
  assert.equal(h.models().length, 0);
  assert.deepEqual(h.waits, []);
  assert.equal(h.artifacts[0].coverage.pending.length, 2);
  assert.equal(h.posts().length, 1);
  assert.match(JSON.parse(h.posts()[0].body).body, /REVISIÓN INCOMPLETA/);
});

test('a HEAD change immediately before publication discards the saved result', async () => {
  const h = harness();
  await runReview({ ...h.options, saveResult: async result => {
    h.artifacts.push(result);
    h.setCurrent({ head: { sha: 'c'.repeat(40), repo: { full_name: repository } } });
  } });
  assert.equal(h.artifacts.length, 1);
  assert.equal(h.posts().length, 0);
  assert.match(h.messages.at(-1), /descartado/);
});

test('a GitHub publication failure is reported instead of announcing a completed review', async () => {
  const h = harness();
  const originalFetch = h.options.fetchImpl;
  await assert.rejects(runReview({ ...h.options, fetchImpl: (url, init) => {
    if (url.startsWith('https://api.github.com/') && init.method === 'POST') return new Response('{}', { status: 403 });
    return originalFetch(url, init);
  } }), /GitHub devolvió HTTP 403/);
  assert.equal(h.artifacts.length, 1);
  assert.ok(!h.messages.some(message => message.startsWith('Revisión completa:')));
});
