import { Badge } from '../ui/Badge'
import { Card } from '../ui/Card'

/**
 * OpenAPI S02 no admite cargas ni referencias de fotos en los comandos de lote. Este bloque
 * reserva el lugar del futuro flujo (K014/K017) sin enviar archivos ni llamar a la API.
 */
export function LotPhotosPending() {
  return (
    <Card as="section" tone="sunken" className="lot-photos" aria-labelledby="lot-photos-title">
      <div className="lot-photos__header">
        <h2 id="lot-photos-title">Fotos (opcional)</h2>
        <Badge tone="warning">Pendiente de validación</Badge>
      </div>
      <p>
        La carga de fotos se habilitará cuando esté disponible su validación segura.
        Puedes guardar y publicar este lote sin fotos.
      </p>
    </Card>
  )
}
