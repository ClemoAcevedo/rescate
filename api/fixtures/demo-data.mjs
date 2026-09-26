// Datos públicos ficticios. Nunca usar estas cuentas fuera de la demo local K012.
export const DEMO_PASSWORD = 'Rescate-K012-solo-pruebas!'
const NORTH_ESTABLISHMENT_ID = '12000000-0000-4000-8000-000000000101'
const SOUTH_ESTABLISHMENT_ID = '12000000-0000-4000-8000-000000000102'

export const demoAccounts = [
  { id: '12000000-0000-4000-8000-000000000001', email: 'operador.norte@example.test', establishmentId: NORTH_ESTABLISHMENT_ID },
  { id: '12000000-0000-4000-8000-000000000002', email: 'operador.sur@example.test', establishmentId: SOUTH_ESTABLISHMENT_ID },
  { id: '12000000-0000-4000-8000-000000000003', email: 'visitante@example.test', establishmentId: null },
]
export const establishments = [
  { id: NORTH_ESTABLISHMENT_ID, name: 'Almacén Norte ficticio', address: 'Dirección ficticia Norte 101', latitude: -33.44, longitude: -70.65 },
  { id: SOUTH_ESTABLISHMENT_ID, name: 'Almacén Sur ficticio', address: 'Dirección ficticia Sur 102', latitude: -33.46, longitude: -70.67 },
]

export const lots = [
  { id: '12000000-0000-4000-8000-000000000201', establishmentId: NORTH_ESTABLISHMENT_ID, status: 'draft' },
  { id: '12000000-0000-4000-8000-000000000202', establishmentId: NORTH_ESTABLISHMENT_ID, status: 'published' },
  { id: '12000000-0000-4000-8000-000000000203', establishmentId: SOUTH_ESTABLISHMENT_ID, status: 'draft' },
  { id: '12000000-0000-4000-8000-000000000204', establishmentId: SOUTH_ESTABLISHMENT_ID, status: 'published' },
]

export function createLotInput(establishment, now = Date.now()) {
  return {
    description: `Pack de verduras — ${establishment.name}`, category: 'Verduras', quantity: 4,
    conditions: 'Datos de prueba; no representa alimentos disponibles.',
    address: establishment.address, latitude: establishment.latitude, longitude: establishment.longitude,
    timeZone: 'America/Santiago',
    pickupStartsAt: new Date(now + 3600000).toISOString(),
    pickupEndsAt: new Date(now + 7 * 86400000).toISOString(),
  }
}
