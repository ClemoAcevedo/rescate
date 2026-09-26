import { useState } from 'react'
import { Button } from '../ui/Button'

type LocationStatus = { tone: 'muted' | 'danger'; message: string } | null

function geolocationMessage(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED) return 'No se concedió permiso para usar tu ubicación. Puedes ingresar las coordenadas manualmente.'
  if (error.code === error.TIMEOUT) return 'La ubicación tardó demasiado en obtenerse. Inténtalo nuevamente o ingresa las coordenadas.'
  return 'No fue posible obtener tu ubicación. Ingresa las coordenadas manualmente.'
}

/**
 * Completa latitud/longitud con la geolocalización del navegador (requiere HTTPS y permiso).
 * No envía nada a la API ni cambia el contrato: el operador revisa y guarda como siempre.
 */
export function UseCurrentLocation({ disabled, onLocate }: { disabled: boolean; onLocate: (latitude: string, longitude: string) => void }) {
  const [locating, setLocating] = useState(false)
  const [status, setStatus] = useState<LocationStatus>(null)
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator

  const locate = () => {
    if (!supported) return
    setLocating(true); setStatus(null)
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        // Seis decimales (~10 cm) bastan para un punto de retiro.
        onLocate(String(Number(coords.latitude.toFixed(6))), String(Number(coords.longitude.toFixed(6))))
        setStatus({ tone: 'muted', message: `Coordenadas completadas con tu ubicación actual (precisión aproximada de ${Math.round(coords.accuracy)} m). Revisa que correspondan al lugar de retiro.` })
        setLocating(false)
      },
      (error) => { setStatus({ tone: 'danger', message: geolocationMessage(error) }); setLocating(false) },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    )
  }

  if (!supported) return null
  return (
    <div className="lot-location">
      <Button variant="secondary" loading={locating} disabled={disabled} onClick={locate}>
        {locating ? 'Obteniendo ubicación…' : 'Usar mi ubicación actual'}
      </Button>
      <p className={`lot-location__status${status?.tone === 'danger' ? ' lot-location__status--error' : ''}`} role="status">
        {status?.message ?? 'Útil si estás en el lugar de retiro. El navegador pedirá permiso.'}
      </p>
    </div>
  )
}
