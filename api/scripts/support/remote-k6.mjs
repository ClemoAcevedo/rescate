import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'

const exec = promisify(execFile)
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2']
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`

export function remoteConfig(env = process.env) {
  if (!env.K6_SSH_TARGET && !env.K6_REMOTE_API_URL) return null
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(env.K6_SSH_TARGET ?? '')) throw new Error('K6_SSH_TARGET requiere usuario@equipo o un alias SSH')
  const url = new URL(env.K6_REMOTE_API_URL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('K6_REMOTE_API_URL requiere el origen HTTP(S) del servidor accesible desde el otro equipo')
  const port = Number(env.K6_API_PORT ?? (url.port || (url.protocol === 'https:' ? 443 : 80)))
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('K6_API_PORT requiere un puerto entre 1024 y 65535')
  return { target: env.K6_SSH_TARGET, apiUrl: url.origin, port }
}

export async function inspectGenerator(config) {
  const command = ['hostname', 'uname -sm', 'k6 version'].join(' && ')
  const { stdout } = await exec('ssh', [...SSH_OPTIONS, config.target, command])
  const [hostname, system, k6] = stdout.trim().split('\n')
  if (!hostname || hostname === os.hostname() || !/^k6 v1\.3\.0(?:[+ (]|$)/.test(k6 ?? '')) throw new Error('Se requiere k6 en otro equipo; comprobar hostname y k6 1.3.0')
  return { hostname, system, k6, transport: 'SSH', apiUrl: config.apiUrl }
}

// Solo viajan la semilla ficticia y el script. SSH protege las sesiones de la semilla;
// no se envían DATABASE_URL ni claves del servidor. El directorio remoto es privado.
export async function runRemoteK6(config, { seedFile, scriptFile, dir, origin, mix, warmup, measured }) {
  const ssh = command => exec('ssh', [...SSH_OPTIONS, config.target, command], { maxBuffer: 10 * 1024 * 1024 })
  const { stdout } = await ssh('umask 077 && mktemp -d /tmp/rescate-k6.XXXXXXXXXX')
  const remote = stdout.trim()
  if (!/^\/tmp\/rescate-k6\.[a-zA-Z0-9]+$/.test(remote)) throw new Error('Directorio temporal remoto inesperado')
  try {
    for (const [local, name] of [[seedFile, 'seed.json'], [scriptFile, 'k032.js']]) {
      // Los datos van por stdin, sin tokens de sesión en argumentos ni salida.
      const child = spawn('ssh', [...SSH_OPTIONS, config.target, `cat > ${shellQuote(`${remote}/${name}`)}`], { stdio: ['pipe', 'ignore', 'inherit'] })
      child.stdin.on('error', () => {})
      child.stdin.end(await readFile(local))
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
      if (code !== 0) throw new Error('No se pudo copiar el material al generador')
    }
    // k032.js escribe /results; en remoto usa RESULTS_DIR, sin cambiar métricas ni umbrales.
    const env = { SEED: `${remote}/seed.json`, API_URL: config.apiUrl, ORIGIN: origin, MIX: mix,
      WARMUP_SECONDS: warmup, MEASURED_SECONDS: measured, RESULTS_DIR: remote }
    const command = `env ${Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ')} k6 run --quiet ${shellQuote(`${remote}/k032.js`)}`
    const child = spawn('ssh', [...SSH_OPTIONS, config.target, command], { stdio: 'inherit' })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    const { stdout: summary } = await ssh(`cat ${shellQuote(`${remote}/k6-summary.json`)}`)
    JSON.parse(summary)
    await writeFile(`${dir}/k6-summary.json`, summary)
    return code
  } finally { await ssh(`rm -rf -- ${shellQuote(remote)}`) }
}
