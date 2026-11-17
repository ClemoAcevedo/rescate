import { useEffect, useRef, useState, type ComponentProps } from 'react'
import type { OperableEstablishment } from '../services/identity-service'
import { establishmentError, searchEstablishments } from '../services/establishments-service'
import { Combobox } from './ui/Combobox'
import { useEstablishmentCatalog } from './EstablishmentCatalog'

type Props = Omit<ComponentProps<typeof Combobox>, 'options' | 'remote' | 'loading' | 'onOpen' | 'onSearch' | 'loadMore'> & { options: OperableEstablishment[] }

export function EstablishmentPicker({ options: initial, onChange, value, ...props }: Props) {
  const { remember } = useEstablishmentCatalog()
  const [search, setSearch] = useState<{ query: string; page: number; version: number } | null>(null)
  const [result, setResult] = useState<{ query: string; page: number; items: OperableEstablishment[]; hasNextPage: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<typeof search>(null)
  const generation = useRef(0)
  useEffect(() => {
    if (!search) return undefined
    const controller = new AbortController()
    const version = ++generation.current
    const timer = setTimeout(() => {
      searchEstablishments(search.query, search.page, controller.signal).then(page => {
        if (controller.signal.aborted || generation.current !== version) return
        setResult(previous => ({ query: search.query, page: page.page, hasNextPage: page.hasNextPage,
          items: search.page > 1 && previous?.query === search.query ? [...previous.items, ...page.items] : page.items }))
        setError(null)
      }).catch(reason => { if (!controller.signal.aborted && generation.current === version) setError(establishmentError(reason)) })
        .finally(() => { if (!controller.signal.aborted && generation.current === version) setLoaded(search) })
    }, search.query ? 250 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [search])
  const loading = search !== loaded
  const matches = !search ? initial : result?.query === search.query ? result.items : []
  const options = matches
  const runSearch = (query: string) => {
    setError(null)
    setSearch(current => ({ query: query.slice(0, 100), page: 1, version: (current?.version ?? 0) + 1 }))
  }
  return <div>
    <Combobox {...props} value={value} onChange={id => {
      const item = options.find(option => option.id === id)
      if (item) remember(item)
      onChange(id)
    }} options={options.map(item => ({ value: item.id, label: item.name }))} limit={options.length}
      selectedLabel={initial.find(item => item.id === value)?.name ?? ''} emptyMessage={error ? 'Reintenta la búsqueda.' : 'Sin coincidencias.'}
      remote loading={loading} onSearch={runSearch} onOpen={() => runSearch('')}
      errorMessage={error} onRetry={() => setSearch(current => current && ({ ...current, version: current.version + 1 }))}
      loadMore={result?.hasNextPage && !loading && result.query === search?.query ? () => setSearch(current => current && ({ ...current, page: result.page + 1 })) : undefined} />
  </div>
}
