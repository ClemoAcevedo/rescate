// K039: resumen de cobertura de api/src a partir de los lcov de node:test (coverage/unit.lcov y
// coverage/integration.lcov). Ramas y funciones se informan por corrida y no se suman: tsx (esbuild)
// y tsc generan rangos distintos. Entre corridas solo se unen líneas (DA). Node no tiene --all,
// así que los .ts que no cargó ninguna corrida se agregan aquí contando sus líneas como lo hace Node.
// Junto a cada lcov, los scripts npm dejan la salida del runner (.exit) y su salida spec (.spec.txt).
// Invocado por npm, este resumen registra el comando (.cmd) y termina con la salida de esa corrida.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import nodeModule from 'node:module'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const api = fileURLToPath(new URL('../', import.meta.url))
const src = resolve(api, 'src')
const out = resolve(api, 'coverage')
const RUNS = [
  { name: 'unit', label: 'Unitarias', script: 'test:coverage' },
  { name: 'integration', label: 'Integración (Compose)', script: 'test:coverage:compose' },
]
const LAYERS = ['domain', 'application', 'http', 'infrastructure', 'root']
const LAYER_LABEL = { root: 'raíz' }
// Un archivo auxiliar (.exit, .cmd, .spec.txt) solo vale si se escribió junto con su lcov.
const SAME_RUN_MS = 120_000

// Mismo corte que el runner de Node: cada línea física, incluidos comentarios, tipos y blancos.
const countLines = text => text.split(/(?<=\r?\n)/u).length
const layerOf = file => file.includes('/') ? file.split('/')[0] : 'root'
const pct = (hit, total) => total ? Math.round(10_000 * hit / total) / 100 : null
const ratio = (hit, total) => ({ hit, total, pct: pct(hit, total) })
const git = (...args) => {
  try { return execFileSync('git', args, { cwd: api, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
}

function withoutComments(code) {
  let text = ''
  for (let i = 0; i < code.length;) {
    if (code.startsWith('//', i)) { const end = code.indexOf('\n', i); i = end < 0 ? code.length : end; continue }
    if (code.startsWith('/*', i)) { const end = code.indexOf('*/', i + 2); i = end < 0 ? code.length : end + 2; text += ' '; continue }
    const quote = code[i]
    if (quote === '"' || quote === "'" || quote === '`') {
      let j = i + 1
      while (j < code.length && code[j] !== quote) j += code[j] === '\\' ? 2 : 1
      text += code.slice(i, j + 1)
      i = j + 1
      continue
    }
    text += code[i++]
  }
  return text
}

// Un archivo sin código ejecutable propio queda vacío al quitar tipos, comentarios, imports con
// nombre y reexportaciones. stripTypeScriptTypes es experimental: si falta o no puede analizar el
// archivo, se trata como código (cuenta con 0 %).
function hasRuntimeCode(source) {
  const strip = nodeModule.stripTypeScriptTypes
  let code
  try {
    try { code = strip(source, { mode: 'strip' }) } catch { code = strip(source, { mode: 'transform' }) }
  } catch { return null }
  return withoutComments(code)
    .replace(/\bimport\s+[\w$*{}\s,]+?\s+from\s*(['"])[^'"]*\1\s*;?/g, '')
    .replace(/\bexport\s*(?:\*|\{[^}]*\})\s*(?:from\s*(['"])[^'"]*\1)?\s*;?/g, '')
    .trim() !== ''
}

function parseLcov(path) {
  const files = new Map()
  const outside = new Set()
  for (const record of readFileSync(path, 'utf8').split('end_of_record')) {
    const sf = record.match(/^SF:(.*)$/m)
    if (!sf) continue
    const absolute = resolve(api, sf[1])
    const file = relative(src, absolute).split(sep).join('/')
    if (file.startsWith('..') || resolve(src, file) !== absolute) { outside.add(relative(api, absolute)); continue }
    const entry = files.get(file) ?? { lines: new Map(), BRF: 0, BRH: 0, FNF: 0, FNH: 0, records: 0 }
    for (const [, line, hits] of record.matchAll(/^DA:(\d+),(\d+)/gm)) entry.lines.set(+line, (entry.lines.get(+line) ?? 0) + +hits)
    for (const key of ['BRF', 'BRH', 'FNF', 'FNH']) entry[key] += Number(record.match(new RegExp(`^${key}:(\\d+)`, 'm'))?.[1] ?? 0)
    entry.records++
    files.set(file, entry)
  }
  return { files, outside: [...outside].sort() }
}

// Totales, envoltorios ejecutados (resultados de primer nivel scripts/*.mjs) y pruebas fallidas del reporter spec.
function parseSpec(raw) {
  // Con FORCE_COLOR el reporter escribe códigos ANSI aunque la salida vaya a una tubería.
  const text = raw.replace(/\u001b\[[\d;?]*[A-Za-z]/gu, '')
  const lines = text.split(/\r?\n/u)
  const count = key => { const match = text.match(new RegExp(`^ℹ ${key} (\\d+)$`, 'm')); return match ? +match[1] : null }
  const totals = lines.findIndex(line => /^ℹ tests \d+$/u.test(line))
  const wrappers = lines.slice(0, totals < 0 ? lines.length : totals)
    .map(line => line.match(/^[✔✖﹣] (scripts\/[\w.-]+\.mjs) \([\d.]+ms\)/u)?.[1]).filter(Boolean)
  const start = lines.indexOf('✖ failing tests:')
  const failures = start < 0 ? [] : [...new Set(lines.slice(start + 1)
    .map(line => line.match(/^\s*✖ (.+?) \([\d.]+ms\)/u)?.[1]).filter(Boolean))]
  return { tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), wrappers, failures }
}

const covered = lines => [...lines.values()].filter(hits => hits > 0).length

// Archivos .ts de src con su cantidad de líneas, si tienen código ejecutable y su última modificación.
const sources = new Map(readdirSync(src, { recursive: true })
  .map(path => path.split(sep).join('/'))
  .filter(path => path.endsWith('.ts') && !path.endsWith('.d.ts'))
  .sort()
  .map(file => {
    const path = resolve(src, file)
    const text = readFileSync(path, 'utf8')
    return [file, { lines: countLines(text), runtime: hasRuntimeCode(text), mtimeMs: statSync(path).mtimeMs }]
  }))

const head = { sha: git('rev-parse', 'HEAD'), date: git('log', '-1', '--format=%cI') }
const status = git('status', '--porcelain')
const srcStatus = git('status', '--porcelain', '--', 'src')
const extraArgs = process.argv.slice(2)

// npm ejecuta en sh el comando de package.json. La corrida en curso es la que ese comando registra en
// coverage/<corrida>.exit, aunque el script npm cambie de nombre. Si su lcov y su salida son de esta
// ejecución, se guarda el comando para comprobar después cómo se generó el lcov (--enable-source-maps).
const lifecycleScript = process.env.npm_lifecycle_script ?? ''
const current = RUNS.find(run => lifecycleScript.includes(`coverage/${run.name}.exit`)) ?? null
if (current) {
  const fresh = path => existsSync(path) && Date.now() - statSync(path).mtimeMs < SAME_RUN_MS
  if (fresh(resolve(out, `${current.name}.lcov`)) && fresh(resolve(out, `${current.name}.exit`))) {
    const options = process.env.NODE_OPTIONS ? [`NODE_OPTIONS=${process.env.NODE_OPTIONS}`] : []
    writeFileSync(resolve(out, `${current.name}.cmd`), `${[lifecycleScript, ...options].join('\n')}\n`)
  }
}

const runs = []
for (const run of RUNS) {
  const lcov = resolve(out, `${run.name}.lcov`)
  if (!existsSync(lcov)) continue
  const modified = statSync(lcov).mtime
  const companion = extension => {
    const path = resolve(out, `${run.name}.${extension}`)
    return existsSync(path) && Math.abs(statSync(path).mtimeMs - modified.getTime()) < SAME_RUN_MS
      ? readFileSync(path, 'utf8') : null
  }
  const exitText = companion('exit')
  const exitCode = exitText === null || Number.isNaN(Number.parseInt(exitText, 10)) ? null : Number.parseInt(exitText, 10)
  const command = companion('cmd')?.trim() || null
  const specText = companion('spec.txt')
  const { files, outside } = parseLcov(lcov)
  const present = [...files.keys()].filter(file => sources.has(file))
  runs.push({ ...run, lcov: relative(api, lcov), modified, exitCode, command, files, outside,
    sourceMaps: command === null ? null : command.includes('--enable-source-maps'),
    spec: specText === null ? null : parseSpec(specText),
    duplicated: [...files].filter(([, e]) => e.records > 1).map(([file]) => `src/${file}`),
    // Node registra una DA por línea física: otro largo indica que el lcov es de otra versión del archivo.
    otherVersion: present.filter(file => files.get(file).lines.size !== sources.get(file).lines),
    changedAfter: present.filter(file => sources.get(file).mtimeMs > modified.getTime()) })
}
if (!runs.length) {
  console.error('No hay coverage/unit.lcov ni coverage/integration.lcov: ejecutar antes npm run test:coverage o test:coverage:compose.')
  process.exit(1)
}

function noticesOf(run) {
  return [
    !run.files.size && 'sin registros de src (corrida interrumpida o patrón de inclusión incorrecto)',
    run.exitCode !== null && run.exitCode !== 0 && 'corrida fallida: el lcov omite lo que no llegó a ejecutarse',
    run.sourceMaps === null && 'comando no registrado: no se puede verificar --enable-source-maps, cifras sin validar',
    run.sourceMaps === false && 'el comando no usa --enable-source-maps: cifras no válidas',
    run.outside.length && `registros fuera de src: ${run.outside.length} (excluidos; no se remapearon a src)`,
    run.otherVersion.length && `archivos con otro largo que el src actual: ${run.otherVersion.length} (lcov de otra versión; fuera de la unión)`,
    run.changedAfter.length && `archivos de src modificados después de la corrida: ${run.changedAfter.length}`,
    run.duplicated.length && 'registros duplicados de un mismo archivo',
  ].filter(Boolean)
}
for (const run of runs) run.notices = noticesOf(run)

function aggregate(files, withBranches) {
  const groups = new Map()
  for (const [file, entry] of files) {
    const layer = layerOf(file)
    const group = groups.get(layer) ?? { files: 0, LH: 0, LF: 0, BRH: 0, BRF: 0, FNH: 0, FNF: 0 }
    group.files++
    group.LH += covered(entry.lines)
    group.LF += entry.lines.size
    if (withBranches) for (const key of ['BRH', 'BRF', 'FNH', 'FNF']) group[key] += entry[key]
    groups.set(layer, group)
  }
  return groups
}

// Archivos con código que la corrida no cargó: suman todas sus líneas como no cubiertas.
function unloadedIn(loaded) {
  return [...sources].filter(([file, info]) => !loaded.has(file) && info.runtime !== false)
    .map(([file, info]) => ({ file: `src/${file}`, layer: layerOf(file), lines: info.lines }))
}

// linesWithUnloaded es la cifra principal; linesLoadedOnly se calcula como el «all files» de Node.
function layerTable(groups, unloaded, withBranches) {
  const rows = {}
  const product = { files: 0, LH: 0, LF: 0, BRH: 0, BRF: 0, FNH: 0, FNF: 0, unloadedFiles: 0, unloadedLines: 0 }
  const names = [...LAYERS, ...[...groups.keys(), ...unloaded.map(u => u.layer)].filter(name => !LAYERS.includes(name))]
  for (const name of new Set(names)) {
    const group = groups.get(name) ?? { files: 0, LH: 0, LF: 0, BRH: 0, BRF: 0, FNH: 0, FNF: 0 }
    const missing = unloaded.filter(u => u.layer === name)
    const missingLines = missing.reduce((sum, u) => sum + u.lines, 0)
    rows[name] = {
      files: group.files, unloadedFiles: missing.length,
      linesWithUnloaded: ratio(group.LH, group.LF + missingLines), linesLoadedOnly: ratio(group.LH, group.LF),
      ...(withBranches && { branches: ratio(group.BRH, group.BRF), functions: ratio(group.FNH, group.FNF) }),
    }
    if (name === 'prototypes') continue
    for (const key of ['files', 'LH', 'LF', 'BRH', 'BRF', 'FNH', 'FNF']) product[key] += group[key]
    product.unloadedFiles += missing.length
    product.unloadedLines += missingLines
  }
  const total = {
    files: product.files, unloadedFiles: product.unloadedFiles,
    linesWithUnloaded: ratio(product.LH, product.LF + product.unloadedLines), linesLoadedOnly: ratio(product.LH, product.LF),
    ...(withBranches && { branches: ratio(product.BRH, product.BRF), functions: ratio(product.FNH, product.FNF) }),
  }
  return { layers: rows, total }
}

const union = new Map()
for (const run of runs) {
  for (const [file, entry] of run.files) {
    if (run.otherVersion.includes(file)) continue
    const lines = union.get(file) ?? new Map()
    for (const [line, hits] of entry.lines) lines.set(line, (lines.get(line) ?? 0) + hits)
    union.set(file, lines)
  }
}
const unloadedAll = unloadedIn(union)
const typesOnly = [...sources].filter(([file, info]) => !union.has(file) && info.runtime === false)
  .map(([file, info]) => ({ file: `src/${file}`, lines: info.lines }))
const unknown = unloadedAll.filter(u => sources.get(u.file.slice(4)).runtime === null).map(u => u.file)
const missingFromSrc = [...union.keys()].filter(file => !sources.has(file)).map(file => `src/${file}`)

const summary = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  commit: head.sha, commitDate: head.date,
  dirty: status === null ? null : status !== '', srcDirty: srcStatus === null ? null : srcStatus !== '',
  goal: 'E1 no fija meta de cobertura de código; las cifras se informan sin umbral.',
  runs: Object.fromEntries(runs.map(run => [run.name, {
    lcov: run.lcov, modifiedAt: run.modified.toISOString(), exitCode: run.exitCode, command: run.command,
    sourceMapsVerified: run.sourceMaps, tests: run.spec, notices: run.notices,
    outsideSrc: run.outside, duplicatedRecords: run.duplicated, otherVersion: run.otherVersion.map(file => `src/${file}`),
    changedAfterRun: run.changedAfter.map(file => `src/${file}`),
    ...layerTable(aggregate(run.files, true), unloadedIn(run.files), true),
  }])),
  union: { runs: runs.map(run => run.name), ...layerTable(aggregate(new Map([...union].map(([f, lines]) => [f, { lines }])), false), unloadedAll, false) },
  unloaded: { withCode: unloadedAll, typesOnly, unknownTreatedAsCode: unknown },
  inLcovButNotInSrc: missingFromSrc,
  files: Object.fromEntries([...sources.keys()].map(file => [`src/${file}`, {
    lines: sources.get(file).lines,
    union: union.has(file) ? ratio(covered(union.get(file)), union.get(file).size) : null,
    ...Object.fromEntries(runs.map(run => [run.name, run.files.has(file)
      ? ratio(covered(run.files.get(file).lines), run.files.get(file).lines.size) : null])),
  }])),
}

const number = value => value === null ? '—' : `${value.toFixed(2).replace('.', ',')} %`
const cell = r => r?.total ? `${number(r.pct)} (${r.hit}/${r.total})` : '—'
const label = name => LAYER_LABEL[name] ?? name
const exitText = code => code === null ? 'sin registrar' : code === 0 ? '0 (pasa)' : `${code} (FALLA)`
const testsText = spec => spec === null ? 'sin salida spec' : spec.tests === null ? 'salida spec sin totales' : `${spec.pass}/${spec.tests} pasan`

const md = [
  '# Cobertura de api/src',
  '',
  `Generado ${summary.generatedAt} con Node ${summary.node}. Commit ${head.sha?.slice(0, 7) ?? 'desconocido'}` +
    ` (${head.date ?? 'sin fecha'}); árbol sucio: ${summary.dirty === null ? 'desconocido' : summary.dirty ? 'sí' : 'no'};` +
    ` cambios sin confirmar en api/src: ${summary.srcDirty === null ? 'desconocido' : summary.srcDirty ? 'sí' : 'no'}.`,
  '',
  summary.goal,
  '',
  '## Corridas',
  '',
  '| Corrida | lcov | Generado | Salida del runner | Pruebas | Archivos de src | Avisos |',
  '| --- | --- | --- | --- | --- | ---: | --- |',
  ...runs.map(run => `| ${run.label} | ${run.lcov} | ${run.modified.toISOString()} | ${exitText(run.exitCode)} | ` +
    `${testsText(run.spec)} | ${run.files.size} | ${run.notices.join('; ') || '—'} |`),
  ...RUNS.filter(run => !runs.some(r => r.name === run.name)).map(run => `| ${run.label} | no ejecutada | — | — | — | — | — |`),
  '',
  ...runs.filter(run => run.spec?.wrappers.length).flatMap(run =>
    [`${run.label}: envoltorios ejecutados (${run.spec.wrappers.length}): ${run.spec.wrappers.join(', ')}.`, '']),
  '## Cifras para citar',
  '',
  'Total sin prototypes. «Líneas» cuenta como no cubiertos los archivos con código que la corrida no cargó. Ramas y',
  'funciones son de los archivos cargados y no se unen entre corridas.',
  '',
  '| Corrida | Salida del runner | Líneas | Ramas | Funciones |',
  '| --- | --- | ---: | ---: | ---: |',
  ...runs.map(run => {
    const total = summary.runs[run.name].total
    return `| ${run.label} | ${exitText(run.exitCode)} | ${cell(total.linesWithUnloaded)} | ${cell(total.branches)} | ${cell(total.functions)} |`
  }),
  ...(runs.length > 1 ? [`| Unión de líneas | — | ${cell(summary.union.total.linesWithUnloaded)} | — | — |`] : []),
  '',
  '## Fallos',
  '',
  ...runs.map(run => {
    if (!run.spec) return `- ${run.label}: sin salida spec registrada (coverage/${run.name}.spec.txt); revisar la salida del runner.`
    const failures = run.spec.failures.map(name => `  - ${name}`)
    if (failures.length) {
      return [`- ${run.label}: pruebas fallidas ${run.spec.fail ?? failures.length} de ${run.spec.tests}; el lcov omite lo que` +
        ' cada una no llegó a ejecutar después del fallo.', ...failures].join('\n')
    }
    return run.exitCode
      ? `- ${run.label}: el runner terminó con ${run.exitCode} sin pruebas fallidas en la salida spec (error del runner).`
      : `- ${run.label}: ninguno (${testsText(run.spec)}).`
  }),
  '',
]
// prototypes va al final y fuera del total.
function layerRows({ layers, total }, withBranches) {
  const row = (name, r) => `| ${name} | ${r.files} | ${r.unloadedFiles} | ${cell(r.linesWithUnloaded)} | ${cell(r.linesLoadedOnly)} |` +
    `${withBranches ? ` ${cell(r.branches)} | ${cell(r.functions)} |` : ''}`
  return [
    ...Object.entries(layers).filter(([name]) => name !== 'prototypes').map(([name, r]) => row(label(name), r)),
    row('**Total sin prototypes**', total),
    ...(layers.prototypes ? [row('prototypes (aparte)', layers.prototypes)] : []),
  ]
}
for (const run of runs) {
  md.push(`## ${run.label}: por capa`, '',
    ...(run.notices.length ? [`Avisos: ${run.notices.join('; ')}.`, ''] : []),
    '«Líneas» suma como no cubiertas todas las líneas de los archivos con código que la corrida no cargó; «Solo cargados»,',
    'ramas y funciones son de los archivos que cargó.', '',
    '| Capa | Archivos cargados | No cargados con código | Líneas | Solo cargados | Ramas | Funciones |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...layerRows(summary.runs[run.name], true),
    '')
}
const warned = runs.filter(run => run.notices.length).map(run => `${run.label}: ${run.notices.join('; ')}`)
md.push(`## Unión de líneas (${runs.map(run => run.label).join(' + ')})`, '',
  'Una línea cuenta como cubierta si alguna corrida la ejecutó. Solo se unen líneas.', '',
  ...(warned.length ? [`Atención: la unión incluye corridas con avisos (${warned.join('. ')}).`, ''] : []),
  '| Capa | Archivos cargados | No cargados con código | Líneas | Solo cargados |',
  '| --- | ---: | ---: | ---: | ---: |',
  ...layerRows(summary.union, false),
  '',
  '## Archivos que ninguna corrida cargó', '',
  'Con código ejecutable (cuentan con 0 % en «Líneas» de su capa; los de prototypes solo en su fila' +
    ` aparte)${unloadedAll.length ? ':' : ': ninguno.'}`,
  ...unloadedAll.map(u => `- ${u.file} (${u.lines} líneas)${unknown.includes(u.file) ? ': no se pudo analizar, se trata como código' : ''}`),
  '',
  `Sin código ejecutable propio (solo tipos, interfaces o imports; fuera del denominador)${typesOnly.length ? ':' : ': ninguno.'}`,
  ...typesOnly.map(u => `- ${u.file} (${u.lines} líneas)`),
  ...(missingFromSrc.length ? ['', `En el lcov pero ya no en src (lcov desactualizado): ${missingFromSrc.join(', ')}`] : []),
  '',
  '## Cómo leer estas cifras', '',
  '- En el PR se cita «Líneas» de «Cifras para citar». «Solo cargados» se calcula como el «all files» de Node, que' +
    ' no ve el código que ninguna prueba cargó, y sobrestima la cobertura.',
  '- Líneas: Node cuenta cada línea física del .ts, incluidos comentarios, tipos y blancos. Según el mapeo quedan' +
    ' como cubiertas o no cubiertas, así que el porcentaje no equivale a sentencias ejecutadas.',
  '- Sin --enable-source-maps Node aplica las posiciones del JavaScript generado sobre el texto TypeScript y las' +
    ' cifras salen falsas sin que el lcov lo muestre. Por eso una corrida sin comando registrado queda sin validar.',
  '- Ramas: V8 no informa las ramas de funciones que nunca se ejecutaron, así que el porcentaje de ramas sale' +
    ' inflado. Leerlo junto con el de funciones.',
  '- Ramas y funciones no se suman entre corridas: las unitarias cargan src con tsx (esbuild) y la integración' +
    ' carga dist compilado por tsc y remapeado con source maps. Solo la unión de líneas es comparable.',
  '- Node no tiene --all: los archivos que no se cargaron no figuran en su «all files». Este resumen los agrega' +
    ' en «Líneas».',
  '- Una corrida fallida deja un lcov parcial: lo que no llegó a ejecutarse figura como no cubierto. La' +
    ' instrumentación puede agotar plazos cortos: un fallo se diagnostica repitiendo ese envoltorio sin cobertura.',
  '- Los procesos terminados con SIGKILL no escriben cobertura. Las pruebas de caída del worker lo hacen a' +
    ' propósito; esas líneas solo cuentan si otra parte de la corrida las ejecutó.',
  '- prototypes (prototipo K005 aislado, ver docs/arquitectura/arquitectura.md) se informa aparte y no entra al' +
    ' total; su prueba (npm run test:photos) no se ejecuta en estas corridas.',
  '- web/ se mide por separado con Chromium y source maps: api/coverage/web/summary.md. No se suman sus métricas con las de Node.',
  '- Los contenedores api y worker de Compose no se miden: las integraciones levantan la API y el worker como' +
    ' procesos del host contra la base de Compose.',
  '- La instrumentación hace más lentos la API y el worker: estas corridas no sirven para medir tiempos.',
  '- --experimental-test-coverage sigue siendo experimental: anotar la versión de Node junto con las cifras.',
  '',
  '## Comandos', '',
  ...runs.map(run => `- ${run.label}: ` + (run.command
    ? run.command.split('\n').map(line => `\`${line}\``).join(' con ')
    :`comando no registrado (el lcov no se generó con npm run ${run.script})`)),
  '- Resumen: `node scripts/coverage-summary.mjs` (lee los lcov que existan en api/coverage/).',
  '',
  '<details><summary>Líneas por archivo</summary>', '',
  `| Archivo | Líneas | Unión | ${runs.map(run => run.label).join(' | ')} |`,
  `| --- | ---: | ---: | ${runs.map(() => '---:').join(' | ')} |`,
  ...Object.entries(summary.files).map(([file, f]) => {
    const unionCell = f.union ? cell(f.union) : sources.get(file.slice(4)).runtime === false ? 'solo tipos' : 'no cargado'
    return `| ${file} | ${f.lines} | ${unionCell} | ${runs.map(run => f[run.name] ? cell(f[run.name]) : '—').join(' | ')} |`
  }),
  '', '</details>', '')

writeFileSync(resolve(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
writeFileSync(resolve(out, 'summary.md'), md.join('\n'))
console.log(md.slice(0, md.indexOf('<details><summary>Líneas por archivo</summary>')).join('\n'))
console.log('Resumen completo en api/coverage/summary.md y api/coverage/summary.json.')

// Desde npm, el resumen termina con la salida de la corrida que acaba de ejecutarse: el comando la
// pasa por tee, que no conserva el código del runner.
if (current) {
  const run = runs.find(r => r.name === current.name)
  if (!run) console.error(`${current.label}: el runner no dejó coverage/${current.name}.lcov.`)
  process.exitCode = run?.exitCode ?? 1
}
// npm agrega los argumentos después de -- al final del comando: llegan aquí, no al runner.
if (extraArgs.length) {
  console.error(`coverage-summary.mjs no acepta argumentos (recibió: ${extraArgs.join(' ')}). ` +
    'Con npm run test:coverage[:compose] -- <args>, los argumentos no llegan al runner de pruebas.')
  process.exitCode = 2
}
