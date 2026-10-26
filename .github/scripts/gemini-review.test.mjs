import assert from 'node:assert/strict';
import test from 'node:test';
import { MODEL, marker, parseReview, parseVerification, deduplicate, formatReview, runReview } from './gemini-review.mjs';
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
const decision = (verdict = 'confirmed') => ({ candidate: 1, verdict, reason: 'El código visible demuestra la decisión.', confidence: 0.95, evidence });
const largeFile = filename => ({ filename, status: 'added', patch: '@@ -0,0 +1,200 @@\n' + Array.from({ length: 200 }, (_, i) => `+const v${i} = '${'x'.repeat(180)}'`).join('\n') });

function harness({ files = [file], reviews = [], statuses = [200], model,
  initial = {}, sourceFiles = {}, patches = {}, sourceError = false, planOptions } = {}) {
  const requests = [], messages = [], waits = [], artifacts = [];
  const pr = { state: 'open', draft: false, changed_files: files.length, title: 'Cambio', body: 'Descripción del autor',
    head: { sha, repo: { full_name: repository } }, base: { sha: base }, ...initial };
  let current = pr;
  let modelCalls = 0;
  const options = { repository, prNumber: 147, expectedSha: sha, githubToken: 'github-test-token', apiKey: 'gemini-test-key',
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
        const status = statuses[Math.min(index, statuses.length - 1)];
        if (status instanceof Error) throw status;
        const payload = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text);
        const result = model ? model(payload, index) : payload.candidates
          ? { decisions: payload.candidates.map((finding, i) => ({ ...decision(), candidate: i + 1, evidence: finding.evidence })) }
          : review([], payload.files);
        return reply(response(result), status);
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
    models: () => requests.filter(r => r.url.includes('generativelanguage.googleapis.com')) };
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

test('verification requires one explicit decision and visible evidence per candidate', () => {
  const context = { snippets: [] };
  assert.equal(parseVerification(response({ decisions: [decision()] }), [finding], [file], context).confirmed.length, 1);
  assert.equal(parseVerification(response({ decisions: [decision('dismissed')] }), [finding], [file], context).confirmed.length, 0);
  assert.equal(parseVerification(response({ decisions: [{ ...decision('unverified'), evidence: null, confidence: null }] }), [finding], [file], context).confirmed.length, 0);
  for (const decisions of [[], [{ ...decision(), candidate: 2 }], [{ ...decision(), confidence: 0.89 }],
    [{ ...decision(), evidence: { ...evidence, quote: 'inventado' } }]]) {
    assert.throws(() => parseVerification(response({ decisions }), [finding], [file], context));
  }
});

test('findings are deduplicated and sorted by severity and confidence', () => {
  const high = { ...finding, line: 12, severity: 'alta' };
  assert.deepEqual(deduplicate([finding, { ...finding, confidence: 0.9 }, high]), [high, finding]);
});

test('a finding is published only after confirmation; artifact keeps usage and decisions', async () => {
  const h = harness({ model: payload => payload.candidates ? { decisions: [decision()] } : review([finding], payload.files) });
  const result = await runReview(h.options);
  assert.equal(h.models().length, 2);
  assert.equal(h.posts().length, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.verification[0].decisions[0].verdict, 'confirmed');
  assert.equal(result.usage.inputTokens, 200);
  assert.equal(result.usage.thinkingTokens, 20);
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

test('no findings needs no second call; a disproven finding is not published', async () => {
  const clean = harness();
  assert.equal((await runReview(clean.options)).findings.length, 0);
  assert.equal(clean.models().length, 1);
  const dismissed = harness({ model: payload => payload.candidates ? { decisions: [decision('dismissed')] } : review([finding], payload.files) });
  assert.equal((await runReview(dismissed.options)).findings.length, 0);
  assert.equal(dismissed.models().length, 2);
});

test('unverified or missing candidate decisions produce an incomplete, retryable review', async () => {
  for (const decisions of [[], [{ ...decision('unverified'), reason: 'Falta el cuerpo de una dependencia.', confidence: null, evidence: null }]]) {
    const h = harness({ model: payload => payload.candidates ? { decisions } : review([finding], payload.files) });
    await assert.rejects(runReview(h.options));
    assert.equal(h.posts().length, 1);
    assert.equal(h.artifacts[0].complete, false);
    const body = JSON.parse(h.posts()[0].body).body;
    assert.ok(body.indexOf('REVISIÓN INCOMPLETA') < body.indexOf('Pendientes'));
    assert.ok(!body.includes('No se encontraron defectos'));
    assert.ok(body.includes(marker(sha, base, false)));
  }
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

test('an unverified candidate in a later batch preserves all prior and current confirmed findings', async () => {
  const files = [largeFile('api/src/a.ts'), largeFile('api/src/z.ts')];
  const candidate = (path, line, title) => ({ ...finding, path, line, title,
    evidence: { path, side: 'RIGHT', line, quote: `const v${line - 1}` } });
  const previous = candidate(files[0].filename, 1, 'Hallazgo confirmado del primer lote');
  const current = candidate(files[1].filename, 1, 'Hallazgo confirmado del segundo lote');
  const uncertain = candidate(files[1].filename, 2, 'Candidato sin verificar');
  const h = harness({ files, model: payload => {
    if (!payload.candidates) return review(payload.part === 1 ? [previous] : [current, uncertain], payload.files);
    return { decisions: payload.candidates.map((item, index) => index === 0
      ? { ...decision(), candidate: index + 1, evidence: item.evidence }
      : { candidate: index + 1, verdict: 'unverified', reason: 'Falta contexto para confirmar este candidato.',
        confidence: null, evidence: null }) };
  } });

  await assert.rejects(runReview(h.options), /sin verificar/);
  assert.equal(h.models().length, 4, 'ambos lotes llegaron a su segunda pasada');
  assert.equal(h.posts().length, 1, 'el resultado parcial se publica antes de fallar el job');
  const result = h.artifacts[0];
  assert.equal(result.complete, false);
  assert.equal(result.coverage.completedBatches, 1);
  assert.deepEqual(result.coverage.reviewedFiles, [files[0].filename]);
  assert.deepEqual(result.coverage.pending.map(item => item.path), [files[1].filename]);
  assert.deepEqual(result.findings.map(item => item.title), [previous.title, current.title]);
  const body = JSON.parse(h.posts()[0].body).body;
  assert.match(body, /REVISIÓN INCOMPLETA/);
  assert.ok(body.includes(previous.title));
  assert.ok(body.includes(current.title));
  assert.ok(!body.includes(uncertain.title));
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
    await assert.rejects(runReview(h.options), /tres intentos/);
    assert.equal(h.models().length, 3);
    assert.equal(h.artifacts[0].complete, false);
  }
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
  assert.equal(telemetry.at(-1).usage.inputTokens, 100);
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
  const verified = parseVerification(response({ decisions: [{ ...decision(), rawPrompt: 'must not be retained',
    evidence: { ...evidence, rawResponse: 'must not be retained' } }] }), parsed.findings, [file], { snippets: [] });
  assert.ok(!JSON.stringify(verified).includes('must not be retained'));
});
