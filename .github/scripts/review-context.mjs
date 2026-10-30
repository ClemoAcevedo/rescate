import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

export const MAX_PATCH_CHARS = 60_000;
export const MAX_CONTEXT_CHARS = 30_000;
export const MAX_BATCHES = 16;
const exec = promisify(execFile);
const shaPattern = /^[a-f0-9]{40}$/;
const cost = (value) => JSON.stringify(value).length;

/** Read immutable Git objects, never the working tree or a PR-provided executable. */
export async function createGitSource(baseSha, headSha, cwd = process.cwd()) {
  if (![baseSha, headSha].every(sha => shaPattern.test(sha))) throw new Error('Referencias Git inválidas.');
  const git = async (...args) => (await exec('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
  })).stdout;
  const base = (await git('merge-base', baseSha, headSha)).trim();
  if (!shaPattern.test(base)) throw new Error('No se pudo resolver la base común del PR.');
  const cache = new Map();
  return {
    baseSha: base,
    async patch(file) {
      const paths = [...new Set([file.filename, file.previous_filename].filter(Boolean))];
      return git('diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--unified=8',
        base, headSha, '--', ...paths.map(name => `:(literal)${name}`));
    },
    async read(filename, side = 'RIGHT') {
      const key = `${side}:${filename}`;
      if (!cache.has(key)) cache.set(key, (async () => {
        try {
          const text = await git('show', '--no-ext-diff', '--no-textconv', `${side === 'LEFT' ? base : headSha}:${filename}`);
          return text.includes('\0') ? null : text;
        } catch (error) {
          // Missing imports are normal (package aliases, removed files). Other failures are explicit.
          if (error.code === 128) return null;
          throw new Error('No se pudo leer el contexto desde Git.');
        }
      })());
      return cache.get(key);
    },
  };
}

/** Line numbers and text on either side, including unchanged hunk context. */
export function patchLines(patch, side = 'RIGHT', changedOnly = false) {
  const result = new Map();
  let oldLine = null;
  let newLine = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) { oldLine = null; newLine = null; continue; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
    if (oldLine === null) continue;
    const prefix = line[0];
    if (prefix === ' ' || prefix === (side === 'LEFT' ? '-' : '+')) {
      if (!changedOnly || prefix !== ' ') result.set(side === 'LEFT' ? oldLine : newLine, line.slice(1));
    }
    if (prefix === ' ' || prefix === '-') oldLine++;
    if (prefix === ' ' || prefix === '+') newLine++;
  }
  return result;
}

/** Split even one huge hunk; reconstruct headers so every fragment keeps exact positions. */
export function splitPatch(patch, budget = MAX_PATCH_CHARS - 2048) {
  const fragments = [];
  let oldLine = 0;
  let newLine = 0;
  let startOld = 0;
  let startNew = 0;
  let oldCount = 0;
  let newCount = 0;
  let lines = [];
  let size = 0;
  let inHunk = false;
  const flush = () => {
    if (lines.length) fragments.push(`@@ -${startOld},${oldCount} +${startNew},${newCount} @@\n${lines.join('\n')}`);
    lines = []; size = 0; oldCount = 0; newCount = 0;
    startOld = oldLine; startNew = newLine;
  };
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) { flush(); inHunk = false; continue; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush(); oldLine = Number(hunk[1]); newLine = Number(hunk[2]);
      startOld = oldLine; startNew = newLine; inHunk = true;
      continue;
    }
    if (!inHunk || ![' ', '+', '-', '\\'].includes(line[0])) continue;
    const lineCost = cost(line) + 1;
    if (lineCost + 100 > budget) throw new Error('Una línea de diff supera el presupuesto por consulta.');
    if (size + lineCost + 100 > budget) flush();
    lines.push(line); size += lineCost;
    if (line[0] === ' ' || line[0] === '-') { oldLine++; oldCount++; }
    if (line[0] === ' ' || line[0] === '+') { newLine++; newCount++; }
  }
  flush();
  return fragments;
}

function priority(file) {
  if (/(?:openapi\.ts|(?:package|pnpm|yarn)-lock\.|\.snap$)/.test(file.filename)) return 4;
  if (/^(api|web)\/src\//.test(file.filename)) return 0;
  if (/migrations\/|openapi\.ya?ml$|\.github\//.test(file.filename)) return 1;
  if (/test|spec|scripts\//.test(file.filename)) return 2;
  return 3;
}

export function planReview(files, { budget = MAX_PATCH_CHARS, maxBatches = MAX_BATCHES } = {}) {
  const batches = [];
  const omitted = [];
  let batch = [];
  const flush = () => { if (batch.length) batches.push(batch); batch = []; };
  for (const file of [...files].sort((a, b) => priority(a) - priority(b) || a.filename.localeCompare(b.filename))) {
    let patches;
    try { patches = splitPatch(file.patch ?? '', budget - cost({ ...file, patch: '' }) - 100); }
    catch (error) { omitted.push({ path: file.filename, reason: error.message }); continue; }
    if (!patches.length) {
      omitted.push({ path: file.filename, reason: file.error ?? 'Sin diff de texto (binario, permisos o renombrado sin cambios).' });
      continue;
    }
    for (const patch of patches) {
      const fragment = { filename: file.filename, previous_filename: file.previous_filename, status: file.status, patch };
      if (cost([...batch, fragment]) > budget) flush();
      if (batches.length >= maxBatches) {
        omitted.push({ path: file.filename, reason: 'Se alcanzó el límite de lotes; quedan fragmentos sin revisar.' });
        break;
      }
      batch.push(fragment);
    }
  }
  flush();
  return { batches, omitted, totalFiles: files.length };
}

function localImports(filename, text) {
  const imports = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)];
  return imports.slice(0, 64).flatMap(([, specifier]) => {
    const name = path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier));
    if (name.startsWith('../') || name.startsWith('/') || name.includes('\0')) return [];
    const stem = name.replace(/\.[cm]?jsx?$/, '');
    return [{ name, candidates: [...new Set([`${stem}.ts`, `${stem}.tsx`, name, `${name}/index.ts`, `${name}/index.tsx`])] }];
  });
}

/** Bounded, numbered source excerpts; imports and changed area docs supply cross-file context. */
export async function buildContext(batch, files, source, budget = MAX_CONTEXT_CHARS) {
  const snippets = [];
  const omitted = new Set();
  const seen = new Set();
  const dependencies = [];
  const focusSources = new Map();
  for (const file of batch) {
    const text = await source.read(file.filename);
    if (text !== null) {
      focusSources.set(file.filename, text);
      dependencies.push(...localImports(file.filename, text));
    }
  }
  const add = async (filename, focus, maxLines) => {
    if (seen.has(filename)) return;
    if (seen.size >= 64) { omitted.add(filename); return; }
    const text = focusSources.get(filename) ?? await source.read(filename);
    if (text === null) return;
    seen.add(filename);
    const lines = text.split('\n');
    // Entire added files already occur in the diff; spend context on their dependencies.
    const visible = focus && patchLines(focus.patch);
    if (focus && lines.every((line, index) => !line || visible.get(index + 1) === line)) return;
    let ranges = [[0, lines.length]];
    if (maxLines && lines.length > maxLines) {
      ranges = [[0, maxLines]];
      omitted.add(filename);
    } else if (text.length > 12_000) {
      if (!focus) { omitted.add(filename); return; }
      const numbers = [...patchLines(focus.patch).keys()];
      ranges = [];
      for (const number of numbers) {
        const from = Math.max(0, number - 26);
        const to = Math.min(lines.length, number + 25);
        const last = ranges.at(-1);
        if (last && from <= last[1]) last[1] = Math.max(last[1], to);
        else ranges.push([from, to]);
      }
      omitted.add(filename); // The prompt must not mistake an excerpt for a full file.
    }
    for (const [from, to] of ranges) {
      // Small windows also bound context for a large added file split across several batches.
      for (let start = from; start < to; start += 80) {
        const snippet = { path: filename, startLine: start + 1, lines: lines.slice(start, Math.min(start + 80, to)) };
        if (cost([...snippets, snippet]) > (maxLines ? budget / 3 : budget)) { omitted.add(filename); return; }
        snippets.push(snippet);
      }
    }
  };
  // Library versions precede code excerpts to avoid claims based on a different API version.
  for (const app of ['api', 'web']) if (batch.some(file => file.filename.startsWith(`${app}/`))) {
    await add(`${app}/package.json`);
    await add(`${app}/tsconfig.json`);
  }
  // Area rules matter even when their documentation is unchanged in this PR.
  // Reserve most of the context budget for source code and direct dependencies.
  const topicsText = [...batch.map(file => file.filename), ...dependencies.map(item => item.name)].join(' ').toLowerCase();
  const areaDocs = [
    [/lot|reserv|commitment|inventory|pickup/, ['docs/lotes.md', 'docs/reservas.md']],
    [/waitlist|offer|queue|fifo|cola/, ['docs/cola-de-espera.md', 'docs/adr/0002-ofertas-parciales.md']],
    [/expir|worker|outbox/, ['docs/vencimientos.md', 'docs/avisos.md']],
    [/auth|session|identity|membership/, ['docs/seguridad.md', 'docs/k008-identidad.md']],
    [/chat|message|conversation/, ['docs/chat.md']],
    [/photo|image|upload|foto/, ['docs/fotos.md']],
    [/panel/, ['docs/panel.md']],
    [/coverage|measure|load|integrity|scale|latency/, ['docs/rendimiento.md']],
  ].filter(([pattern]) => pattern.test(topicsText)).flatMap(([, paths]) => paths);
  for (const filename of new Set(areaDocs)) {
    if (cost(snippets) >= budget / 3) { omitted.add(filename); continue; }
    await add(filename, undefined, 60);
  }
  // Resolve each import once, then prioritize dependencies changed elsewhere in the PR.
  const changed = new Set(files.map(file => file.filename));
  const imports = [...new Map(dependencies.map(item => [item.name, item])).values()]
    .sort((a, b) => Number(b.candidates.some(name => changed.has(name))) - Number(a.candidates.some(name => changed.has(name))));
  for (const dependency of imports.slice(0, 32)) {
    for (const filename of dependency.candidates) {
      if (await source.read(filename) !== null) {
        await add(filename, batch.find(file => file.filename === filename));
        break;
      }
    }
  }
  imports.slice(32).forEach(item => omitted.add(item.name));
  for (const file of batch) await add(file.filename, file);
  const topics = new Set(batch.flatMap(file => file.filename.split(/[/.\-_]/)).filter(word => word.length >= 4));
  for (const file of files.filter(file => /^docs\/.+\.md$/.test(file.filename) &&
      file.filename.split(/[/.\-_]/).some(word => topics.has(word)))) await add(file.filename);
  const contract = files.find(file => file.filename === 'docs/api/openapi.yaml');
  if (contract && batch.some(file => /^(api|web)\/src\//.test(file.filename))) await add(contract.filename, contract);
  return { snippets, limitedFiles: [...omitted] };
}
