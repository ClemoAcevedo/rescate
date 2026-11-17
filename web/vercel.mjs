// Vercel evalúa esta configuración con las variables del entorno de despliegue.
const origin = process.env.API_PROXY_TARGET
if (!origin) throw new Error('Configura API_PROXY_TARGET con el origen HTTPS de la API en Railway')
const target = new URL(origin)
if (target.protocol !== 'https:' || target.origin !== origin) {
  throw new Error('API_PROXY_TARGET debe ser un origen HTTPS exacto, sin rutas ni credenciales')
}
if (process.env.VITE_API_BASE_URL && process.env.VITE_API_BASE_URL !== '/api') {
  throw new Error('Vercel requiere VITE_API_BASE_URL=/api para las cookies del mismo origen')
}
if (process.env.VITE_AUTH_MOCK_SCENARIO) {
  throw new Error('El despliegue requiere identidad real: elimina VITE_AUTH_MOCK_SCENARIO')
}
const secret = process.env.API_PROXY_SECRET
if (!/^[A-Za-z0-9+/=_-]{32,256}$/.test(secret ?? '')) throw new Error('API_PROXY_SECRET requiere un secreto aleatorio de al menos 32 caracteres')

export const config = {
  framework: 'vite',
  installCommand: 'npm ci',
  buildCommand: 'npm run build && node scripts/write-release.mjs',
  outputDirectory: 'dist',
  routes: [
    // Transform de petición en el CDN: conserva el proxy directo y las cargas de 5 MiB.
    // El secreto nunca es una cabecera de respuesta ni entra al bundle de Vite.
    { src: '/api(?:/(.*))?$', dest: `${origin}/$1`, transforms: [
      { type: 'request.headers', op: 'set', target: { key: 'x-rescate-proxy-secret' }, args: secret },
    ] },
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index.html' },
  ],
}
