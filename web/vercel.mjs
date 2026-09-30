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

export const config = {
  framework: 'vite',
  installCommand: 'npm ci',
  buildCommand: 'npm run build && node scripts/write-release.mjs',
  outputDirectory: 'dist',
  rewrites: [
    { source: '/api/:path*', destination: `${origin}/:path*` },
    { source: '/(.*)', destination: '/index.html' },
  ],
}
