import type { CreateLotDraftRequest, LotResponse, UpdateLotDraftRequest } from '../services/lots-service'
import { instantToLocalInput, isValidTimeZone, localInputToInstant } from './lot-time'

/** Valores tal como los edita el formulario; las conversiones al contrato ocurren al enviar. */
export type LotFormValues = {
  description: string
  category: string
  quantity: string
  conditions: string
  address: string
  latitude: string
  longitude: string
  timeZone: string
  pickupStartsAt: string
  pickupEndsAt: string
}

export type LotField = keyof LotFormValues
export type LotFieldErrors = Partial<Record<LotField | 'establishmentId', string>>
type Declaration = Omit<CreateLotDraftRequest, 'conditions'> & { conditions: string | null }

export function emptyLotValues(timeZone: string): LotFormValues {
  return {
    description: '', category: '', quantity: '', conditions: '', address: '',
    latitude: '', longitude: '', timeZone, pickupStartsAt: '', pickupEndsAt: '',
  }
}

export function lotValues(lot: LotResponse): LotFormValues {
  return {
    description: lot.description,
    category: lot.category,
    quantity: String(lot.quantity),
    conditions: lot.conditions ?? '',
    address: lot.address,
    latitude: String(lot.latitude),
    longitude: String(lot.longitude),
    timeZone: lot.timeZone,
    pickupStartsAt: instantToLocalInput(lot.pickupStartsAt, lot.timeZone),
    pickupEndsAt: instantToLocalInput(lot.pickupEndsAt, lot.timeZone),
  }
}

const blank = (value: string) => value.trim() === ''

/**
 * Filtros de escritura: devuelven el valor aceptado o null para ignorar el cambio completo.
 * Rechazar (en vez de quitar caracteres) evita alterar el significado: «1.5» no se vuelve 15.
 */
export function acceptInteger(value: string): string | null {
  return /^\d*$/.test(value) ? value : null
}

/** Coordenada en escritura: signo inicial opcional, dígitos y un separador; la coma se toma como punto. */
export function acceptDecimal(value: string): string | null {
  const normalized = value.trim().replace(',', '.')
  return /^-?\d*\.?\d*$/.test(normalized) ? normalized : null
}

/**
 * Arma la declaración completa del contrato. Estas comprobaciones solo evitan envíos que
 * la API rechazaría; la validación que decide sigue siendo la del servidor.
 */
export function buildDeclaration(values: LotFormValues): { declaration: Declaration } | { errors: LotFieldErrors } {
  const errors: LotFieldErrors = {}
  for (const field of ['description', 'category', 'address'] as const) {
    if (blank(values[field])) errors[field] = 'Completa este campo; no puede contener solo espacios.'
  }
  const quantity = Number(values.quantity)
  if (!Number.isInteger(quantity) || quantity < 1) errors.quantity = 'Indica un número entero de packs, mayor o igual a 1.'
  const latitude = Number(values.latitude)
  if (blank(values.latitude) || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) errors.latitude = 'Indica una latitud entre -90 y 90.'
  const longitude = Number(values.longitude)
  if (blank(values.longitude) || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) errors.longitude = 'Indica una longitud entre -180 y 180.'

  let pickupStartsAt: string | null = null
  let pickupEndsAt: string | null = null
  if (!isValidTimeZone(values.timeZone)) {
    errors.timeZone = 'Elige una zona horaria válida, por ejemplo America/Santiago.'
  } else {
    pickupStartsAt = localInputToInstant(values.pickupStartsAt, values.timeZone)
    pickupEndsAt = localInputToInstant(values.pickupEndsAt, values.timeZone)
    if (!pickupStartsAt) errors.pickupStartsAt = 'Indica una fecha y hora válidas en la zona horaria del lote.'
    if (!pickupEndsAt) errors.pickupEndsAt = 'Indica una fecha y hora válidas en la zona horaria del lote.'
    if (pickupStartsAt && pickupEndsAt && Date.parse(pickupEndsAt) <= Date.parse(pickupStartsAt)) {
      errors.pickupEndsAt = 'El cierre del retiro debe ser posterior al inicio.'
    }
  }

  if (Object.keys(errors).length > 0 || !pickupStartsAt || !pickupEndsAt) return { errors }
  return {
    declaration: {
      description: values.description,
      category: values.category,
      quantity,
      conditions: blank(values.conditions) ? null : values.conditions,
      address: values.address,
      latitude,
      longitude,
      timeZone: values.timeZone,
      pickupStartsAt,
      pickupEndsAt,
    },
  }
}

/** Solo los campos modificados; los instantes se comparan por valor, no por texto. */
export function changedFields(declaration: Declaration, lot: LotResponse): Omit<UpdateLotDraftRequest, 'version'> {
  const changes: Omit<UpdateLotDraftRequest, 'version'> = {}
  const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b)
  if (declaration.description !== lot.description) changes.description = declaration.description
  if (declaration.category !== lot.category) changes.category = declaration.category
  if (declaration.quantity !== lot.quantity) changes.quantity = declaration.quantity
  if (declaration.conditions !== lot.conditions) changes.conditions = declaration.conditions
  if (declaration.address !== lot.address) changes.address = declaration.address
  if (declaration.latitude !== lot.latitude) changes.latitude = declaration.latitude
  if (declaration.longitude !== lot.longitude) changes.longitude = declaration.longitude
  if (declaration.timeZone !== lot.timeZone) changes.timeZone = declaration.timeZone
  if (!sameInstant(declaration.pickupStartsAt, lot.pickupStartsAt)) changes.pickupStartsAt = declaration.pickupStartsAt
  if (!sameInstant(declaration.pickupEndsAt, lot.pickupEndsAt)) changes.pickupEndsAt = declaration.pickupEndsAt
  return changes
}

/** Diferencia visible entre formulario y lote guardado, sin exigir que el formulario sea válido. */
export function hasUnsavedChanges(values: LotFormValues, lot: LotResponse): boolean {
  const saved = lotValues(lot)
  return (Object.keys(saved) as LotField[]).some((field) => values[field] !== saved[field])
}

/** `details.issues[].path` es JSON Pointer; solo interesan los campos de primer nivel del formulario. */
export function fieldErrorsFromIssues(issues: Array<{ path: string; message: string }>): LotFieldErrors {
  const fields = new Set<string>([...Object.keys(emptyLotValues('')), 'establishmentId'])
  const errors: LotFieldErrors = {}
  for (const issue of issues) {
    const field = issue.path.split('/')[1]
    if (field && fields.has(field)) errors[field as LotField] ??= issue.message
  }
  return errors
}
