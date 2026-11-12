import { Link } from 'react-router-dom'
import { Icon } from './Icon'

export function OperatorPageHeader({ title, description }: { title: string; description: string }) {
  return <header className="page-header">
    <div><p className="eyebrow">Operación</p><h1>{title}</h1><p>{description}</p></div>
    <Link className="ui-button ui-button--primary" to="/operador/lotes/nuevo"><Icon name="plus" />Publicar lote</Link>
  </header>
}
