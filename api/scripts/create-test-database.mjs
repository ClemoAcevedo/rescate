import pg from 'pg'

export async function createTestDatabase(baseUrl, databaseName) {
  if (!/^rescate_[a-z0-9_]+$/.test(databaseName)) throw new Error('Nombre de base de prueba inválido')

  const maintenanceUrl = new URL(baseUrl)
  maintenanceUrl.pathname = '/postgres'
  const client = new pg.Client({ connectionString: maintenanceUrl.href })
  await client.connect()
  try {
    await client.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`)
  } finally {
    await client.end()
  }

  const databaseUrl = new URL(baseUrl)
  databaseUrl.pathname = `/${databaseName}`
  return databaseUrl.href
}
