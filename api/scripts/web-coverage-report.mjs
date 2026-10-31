import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, relative, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CoverageReport } from 'monocart-coverage-reports'
import ts from '../../web/node_modules/typescript/lib/typescript.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const web = resolve(root, 'web')
const output = resolve(root, 'api/coverage/web')
const raw = process.env.WEB_COVERAGE_DIR ?? resolve(output, 'raw')
const files = (await readdir(raw)).filter(name => name.endsWith('.json'))
assert.ok(files.length, 'Sin datos de Chromium: no publicar cobertura vacía como exitosa')
const normalize = (path, info = {}) => {
  if (info.distFile && info.url && !info.url.includes('://')) {
    return posix.normalize(posix.join(posix.dirname(info.distFile), info.url))
  }
  const index = path.replaceAll('\\', '/').lastIndexOf('/src/')
  return index >= 0 ? `src/${path.slice(index + 5)}` : path
}
const include = path => /^src\/.*\.(ts|tsx)$/.test(normalize(path)) && !path.endsWith('.d.ts')
const compile = (source, filename) => ts.transpileModule(source, { fileName: filename,
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, sourceMap: true, removeComments: true } })
const runtimePaths = new Set()
for (const path of await readdir(resolve(web, 'src'), { recursive: true })) {
  const sourcePath = `src/${path}`
  if (!include(sourcePath)) continue
  const compiled = compile(await readFile(resolve(web, sourcePath), 'utf8'), sourcePath).outputText
  if (compiled.replace(/\/\/# sourceMappingURL=.*$/m, '').replace(/export \{\s*\};?/, '').trim()) runtimePaths.add(sourcePath)
}
const report = new CoverageReport({ name: 'Rescate · cobertura del frontend', baseDir: web, outputDir: output,
  reports: ['v8', 'v8-json', 'lcovonly'], clean: false,
  entryFilter: entry => /\/src\/.*\.(ts|tsx)(\?|$)/.test(entry.url),
  sourcePath: normalize, sourceFilter: path => include(path) && runtimePaths.has(normalize(path)),
  all: { dir: resolve(web, 'src'), filter: path => {
    if (!runtimePaths.has(normalize(path))) return false
    return true
  }, transformer: entry => {
    const result = compile(entry.source, fileURLToPath(entry.url))
    entry.source = result.outputText
    entry.sourceMap = JSON.parse(result.sourceMapText)
  } },
})
for (const file of files) await report.add(JSON.parse(await readFile(resolve(raw, file), 'utf8')))
const result = await report.generate()
assert.equal(new Set(result.files.map(file => file.sourcePath)).size, result.files.length, 'No duplicar fuentes entre puertos o navegaciones')
assert.deepEqual(new Set(result.files.map(file => file.sourcePath)), runtimePaths, 'El denominador debe incluir todos los archivos ejecutables')
assert.ok(result.files.some(file => file.summary.lines.covered > 0), 'No se recuperaron fuentes TypeScript ejecutadas')
const definitions = {
  pages: 'Pantallas y coordinación de acciones del usuario',
  components: 'Controles compartidos, navegación y componentes de lotes',
  services: 'Cliente HTTP, validación de respuestas y acceso a la API',
  auth: 'Estado de sesión, acceso y autorización de la interfaz',
  notifications: 'Consulta periódica con pestaña visible y recuperación al reconectar',
  lots: 'Formularios, fechas, fotos y estados de lotes',
  app: 'Rutas y composición de la aplicación',
  root: 'Entrada de la aplicación y configuración compartida',
}
const modules = {}
for (const file of result.files) {
  assert.ok(include(file.sourcePath), `Fuente inesperada: ${file.sourcePath}`)
  const folder = file.sourcePath.slice(4).split('/')
  const name = folder.length > 1 ? folder[0] : 'root'
  const module = modules[name] ??= { responsibility: definitions[name] ?? name, files: [], covered: 0, total: 0 }
  module.files.push(file.sourcePath)
  module.covered += file.summary.lines.covered
  module.total += file.summary.lines.total
}
const summary = { commit: execFileSync('git', ['-c', `safe.directory=${resolve(root)}`, 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['-c', `safe.directory=${resolve(root)}`, 'status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
  node: process.version, scope: process.env.WEB_COVERAGE_SCOPE ?? 'Suite de navegador HTTPS con API y PostgreSQL reales; incluye respuestas controladas',
  metric: 'Líneas de TypeScript recuperadas con source maps desde V8; archivos no ejecutados incluidos con cero', modules }
const percent = (covered, total) => total ? `${(covered / total * 100).toFixed(2)} % (${covered}/${total})` : 'N/A (sin código ejecutable)'
const lines = ['# Cobertura del frontend por módulo', '', `Commit: ${summary.commit}; cambios sin confirmar: ${summary.dirty ? 'sí' : 'no'}; Node ${summary.node}.`, '',
  `Recorridos: ${summary.scope}.`, '', summary.metric + '.', '',
  '| Módulo | Responsabilidad | Líneas |', '| --- | --- | --- |',
  ...Object.entries(modules).sort().map(([name, m]) => `| ${name} | ${m.responsibility} | ${percent(m.covered, m.total)} |`), '',
  'El porcentaje muestra ejecución, no corrección de los comportamientos. Las ramas sin recorrer y los escenarios simulados se revisan junto a las pruebas. No mide CSS ni sustituye integración con servicios reales.', '',
  `Detalle por archivo y líneas sin recorrer: [reporte HTML](index.html). LCOV: ${relative(output, resolve(output, 'lcov.info'))}.`, '']
await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2))
await writeFile(resolve(output, 'summary.md'), lines.join('\n'))
console.log(lines.join('\n'))
