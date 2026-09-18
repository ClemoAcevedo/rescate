import { request } from './httpClient'

export type HealthResponse = {
  status: 'ok'
}

function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  return 'status' in value && value.status === 'ok'
}

export function checkHealth() {
  return request({
    path: '/health',
    response: 'json',
    validate: isHealthResponse,
  })
}
