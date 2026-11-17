/* eslint-disable react-refresh/only-export-components -- contexto de selección compartido por las vistas del operador. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import type { OperableEstablishment } from '../services/identity-service'
import { establishmentError, getEstablishment } from '../services/establishments-service'
import { Alert } from './ui/Alert'
import { Button } from './ui/Button'
import { RecordSkeleton } from './RecordSkeleton'

type Catalog = { establishments: OperableEstablishment[]; remember: (item: OperableEstablishment) => void }
const Context = createContext<Catalog | null>(null)

/** Solo guarda las selecciones visitadas de esta sesión; el servidor decide permisos en cada operación. */
export function EstablishmentCatalog({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const requested = pathname.startsWith('/operador/') ? params.get('establecimiento')?.toLowerCase() ?? null : null
  const [known, setKnown] = useState<OperableEstablishment[]>([])
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const establishments = useMemo(() => [...new Map([...(session?.operableEstablishments ?? []), ...known].map(item => [item.id, item])).values()], [session, known])
  const remember = useCallback((item: OperableEstablishment) => setKnown(current => [...current.filter(old => old.id !== item.id), item]), [])
  const missing = requested && session && !establishments.some(item => item.id === requested) ? requested : null
  useEffect(() => {
    if (!missing) return undefined
    const controller = new AbortController()
    getEstablishment(missing, controller.signal).then(item => {
      if (!controller.signal.aborted) remember(item)
    }).catch(error => { if (!controller.signal.aborted) setFailure({ id: missing, message: establishmentError(error) }) })
    return () => controller.abort()
  }, [missing, remember, retry])
  return <Context.Provider value={{ establishments, remember }}>
    {missing ? <main className="page-content" aria-busy={failure?.id !== missing}>
      {failure?.id === missing ? <Alert tone="danger" role="alert">{failure.message} <Button onClick={() => { setFailure(null); setRetry(value => value + 1) }}>Reintentar</Button></Alert>
        : <RecordSkeleton label="Consultando el establecimiento seleccionado…" />}
    </main> : children}
  </Context.Provider>
}

export function useEstablishmentCatalog(): Catalog {
  const value = useContext(Context)
  if (!value) throw new Error('La selección requiere EstablishmentCatalog.')
  return value
}
