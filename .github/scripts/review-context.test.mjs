import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MAX_PATCH_CHARS, MAX_CONTEXT_CHARS, splitPatch, patchLines, planReview, buildContext, createGitSource } from './review-context.mjs';

const patch = '@@ -3,4 +3,5 @@\n same\n-old\n+new\n+extra\n end\n tail\n@@ -20,2 +21,1 @@\n-removed\n final';
const file = { filename: 'api/src/panel.ts', status: 'modified', patch };
const encoded = value => JSON.stringify(value).length;
const manyLines = count => '@@ -0,0 +1,' + count + ' @@\n' + Array.from({ length: count }, (_, i) => `+const line${i} = '${'x'.repeat(150)}'`).join('\n');

test('splitting preserves every changed line on both sides, even within one hunk', () => {
  for (const source of [patch, manyLines(1400), '@@ -1,400 +0,0 @@\n' + Array.from({ length: 400 }, (_, i) => `-remove${i}`).join('\n')]) {
    const fragments = splitPatch(source, 700);
    for (const side of ['LEFT', 'RIGHT']) {
      const combined = new Map(fragments.flatMap(fragment => [...patchLines(fragment, side, true)]));
      assert.deepEqual(combined, patchLines(source, side, true));
    }
    for (const fragment of fragments) assert.ok(encoded(fragment) <= 700);
  }
});

test('escaped text respects the serialized budget and giant single lines are explicit', () => {
  const escaped = '@@ -0,0 +1,500 @@\n' + Array.from({ length: 500 }, () => '+' + '"\\'.repeat(50)).join('\n');
  const plan = planReview([{ ...file, patch: escaped }], { budget: 1000, maxBatches: 1000 });
  assert.equal(plan.omitted.length, 0);
  for (const batch of plan.batches) assert.ok(encoded(batch) <= 1000);
  const huge = planReview([{ ...file, patch: '@@ -0,0 +1 @@\n+' + 'x'.repeat(MAX_PATCH_CHARS) }]);
  assert.equal(huge.batches.length, 0);
  assert.match(huge.omitted[0].reason, /línea/);
});

test('all text files are batched, production code precedes tests, binary files have a reason', () => {
  const files = ['api/scripts/test-panel.mjs', 'README.md', 'api/src/domain/panel.ts', 'web/src/pages/Panel.tsx', 'web/src/services/openapi.ts']
    .map(filename => ({ ...file, filename, patch: manyLines(300) }));
  const plan = planReview([...files, { filename: 'image.png', patch: 'Binary files differ' }]);
  assert.ok(plan.batches.length > 1);
  assert.equal(plan.batches[0][0].filename, 'api/src/domain/panel.ts');
  assert.deepEqual(new Set(plan.batches.flat().map(file => file.filename)), new Set(files.map(file => file.filename)));
  assert.deepEqual(plan.omitted.map(item => item.path), ['image.png']);
});

test('a fragmented file is marked pending when its final chunks exceed the cap', () => {
  const plan = planReview([{ ...file, patch: manyLines(2000) }], { maxBatches: 1 });
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.omitted[0].path, file.filename);
});

test('PR147-shaped regression: all 34 paths survive 186k characters of text', () => {
  const paths = ['.github/workflows/ci.yml', 'README.md', 'api/package.json', 'api/scripts/explain-scale.mjs',
    'api/scripts/generate-http-types.mjs', 'api/scripts/test-panel-compose.mjs', 'api/scripts/test-panel.mjs',
    'api/scripts/test-web-compose.mjs', 'api/scripts/test-web-panel.mjs', 'api/scripts/test-web-responsive.mjs',
    'api/src/app.ts', 'api/src/application/panel/ports.ts', 'api/src/application/panel/use-cases.ts', 'api/src/composition.ts',
    'api/src/domain/panel.ts', 'api/src/http/errors.ts', 'api/src/http/openapi.ts', 'api/src/http/panel-router.ts',
    'api/src/infrastructure/postgres/panel-repository.ts', 'api/test/panel.test.ts', 'api/test/support/openapi.ts',
    'docs/README.md', 'docs/api/README.md', 'docs/api/openapi.yaml', 'docs/k013-trazabilidad.md', 'docs/panel.md',
    'docs/rendimiento.md', 'web/README.md', 'web/src/app/App.tsx', 'web/src/components/SiteHeader.tsx',
    'web/src/pages/PanelPage.tsx', 'web/src/pages/panel.css', 'web/src/services/openapi.ts', 'web/src/services/panel-service.ts'];
  const files = paths.map((filename, i) => ({ ...file, filename, patch: manyLines(i === 6 || i === 8 ? 100 : 28) }));
  const plan = planReview(files);
  assert.equal(plan.omitted.length, 0);
  assert.equal(new Set(plan.batches.flat().map(file => file.filename)).size, 34);
  assert.ok(plan.batches.length >= 3);
  for (const batch of plan.batches) assert.ok(encoded(batch) <= MAX_PATCH_CHARS);
});

test('context carries package versions, resolves .js imports to TypeScript and includes area docs', async () => {
  const sources = {
    'api/src/panel.ts': "import { check } from './domain/check.js'\nexport const route = () => check()",
    'api/src/domain/check.ts': 'export const check = () => false',
    'api/package.json': '{"dependencies":{"express":"^5.2.1"}}',
    'api/tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'docs/panel.md': 'Reglas vigentes del panel.',
    'docs/photos.md': 'No relacionado.',
  };
  const source = { read: async name => sources[name] ?? null };
  const context = await buildContext([file], [file, { filename: 'docs/panel.md' }, { filename: 'docs/photos.md' }], source);
  const paths = new Set(context.snippets.map(item => item.path));
  for (const name of ['api/package.json', 'api/tsconfig.json', 'api/src/domain/check.ts', 'api/src/panel.ts', 'docs/panel.md']) assert.ok(paths.has(name), name);
  assert.ok(!paths.has('docs/photos.md'));
  assert.ok(encoded(context.snippets) <= MAX_CONTEXT_CHARS);
});

test('full added source is not duplicated; context gaps and excerpt positions are explicit', async () => {
  const text = Array.from({ length: 2000 }, (_, i) => `line${i} ${'x'.repeat(30)}`).join('\n');
  const source = { read: async name => name === file.filename ? text : null };
  const partial = { ...file, patch: '@@ -1799,1 +1799,2 @@\n line1798\n+line1799' };
  const context = await buildContext([partial], [partial], source, 4000);
  assert.ok(context.snippets[0].startLine > 1700);
  assert.ok(context.limitedFiles.includes(file.filename));
  assert.ok(encoded(context.snippets) <= 4000);
  const full = { ...file, patch: '@@ -0,0 +1,2 @@\n+first\n+second' };
  assert.deepEqual((await buildContext([full], [full], { read: async name => name === file.filename ? 'first\nsecond\n' : null })).snippets, []);
});

test('Git source reads immutable blobs, computes merge-base and treats metacharacters literally', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rescate-review-git-'));
  const run = promisify(execFile);
  const git = async (...args) => (await run('git', args, { cwd })).stdout.trim();
  const commit = async message => {
    await git('add', '.');
    await git('-c', 'user.name=Reviewer test', '-c', 'user.email=reviewer@example.invalid', 'commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    await git('init', '--initial-branch=base');
    await mkdir(join(cwd, 'api/src'), { recursive: true });
    const name = 'api/src/a[1].ts';
    await writeFile(join(cwd, name), 'before\n');
    await writeFile(join(cwd, 'api/src/a1.ts'), 'should not match a glob\n');
    const common = await commit('base');
    await git('switch', '-c', 'feature');
    await writeFile(join(cwd, name), 'after\n');
    await writeFile(join(cwd, 'binary.png'), Buffer.from([0, 1, 2, 0, 3]));
    const head = await commit('head');
    await git('switch', 'base');
    await writeFile(join(cwd, 'unrelated.md'), 'base advanced\n');
    const tip = await commit('new base');
    await writeFile(join(cwd, name), 'uncommitted working tree\n');
    const source = await createGitSource(tip, head, cwd);
    assert.equal(source.baseSha, common);
    assert.equal(await source.read(name), 'after\n');
    assert.equal(await source.read(name, 'LEFT'), 'before\n');
    assert.equal(await source.read('missing.ts'), null);
    assert.equal(await source.read('binary.png'), null);
    const diff = await source.patch({ filename: name });
    assert.match(diff, /\+after/);
    assert.ok(!diff.includes('should not match'));
    const plan = planReview([{ filename: name, patch: diff }]);
    assert.equal(plan.omitted.length, 0);
    assert.equal(patchLines(plan.batches[0][0].patch, 'RIGHT', true).get(1), 'after');
    await assert.rejects(createGitSource('invalid', head, cwd), /inválidas/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('diff metadata between renamed sections never becomes source evidence', () => {
  const raw = 'diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-before\ndiff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+after';
  assert.deepEqual([...patchLines(raw, 'LEFT', true)], [[1, 'before']]);
  assert.deepEqual([...patchLines(raw, 'RIGHT', true)], [[1, 'after']]);
  const fragments = splitPatch(raw);
  assert.equal(fragments.length, 2);
  assert.ok(fragments.every(fragment => !fragment.includes('/dev/null')));
});
