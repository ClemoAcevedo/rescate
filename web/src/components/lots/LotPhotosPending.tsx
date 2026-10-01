import { Badge } from '../ui/Badge'
import { Card } from '../ui/Card'

/**
 * Reserva el lugar de la carga de fotos sin enviar archivos ni llamar a la API. Las
 * operaciones de fotos de OpenAPI (K014) se conectan al formulario en K017.
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
