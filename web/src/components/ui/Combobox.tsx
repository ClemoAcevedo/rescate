import { useId, useMemo, useState, type KeyboardEvent } from 'react'

export type ComboboxOption = { value: string; label: string }

type ComboboxProps = {
  /** Props de `FormField`: id, required, aria-describedby y aria-invalid. */
  id: string
  required?: boolean
  'aria-describedby'?: string
  'aria-invalid'?: true
  name: string
  options: ComboboxOption[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
  /** Máximo de opciones visibles; el resto se alcanza escribiendo más. */
  limit?: number
}

const normalize = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es')

/**
 * Selección con filtro por texto (patrón ARIA combobox + listbox). Filtra en el navegador
 * sin distinguir mayúsculas ni tildes; no hace peticiones. El valor es el `value` de la
 * opción y se envía en un input oculto con `name`.
 */
export function Combobox({
  id, required = false, name, options, value, onChange, disabled = false, placeholder, limit = 50, ...aria
}: ComboboxProps) {
  const listboxId = useId()
  const selectedLabel = options.find((option) => option.value === value)?.label ?? ''
  const [query, setQuery] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const text = query ?? selectedLabel

  const matches = useMemo(() => {
    const needle = normalize(query ?? '')
    return needle ? options.filter((option) => normalize(option.label).includes(needle)) : options
  }, [options, query])
  const visible = matches.slice(0, limit)
  const activeIndex = Math.min(active, visible.length - 1)

  const close = () => { setOpen(false); setQuery(null); setActive(0) }
  const select = (option: ComboboxOption) => { onChange(option.value); close() }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { setOpen(true); return }
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) => Math.max(0, Math.min(visible.length - 1, current + step)))
    } else if (event.key === 'Enter' && open) {
      event.preventDefault()
      if (visible[activeIndex]) select(visible[activeIndex])
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      close()
    }
  }

  return (
    <div className="ui-combobox">
      <input
        {...aria}
        id={id}
        className="ui-control"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={open && visible[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
        aria-required={required || undefined}
        autoComplete="off"
        placeholder={placeholder}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          setQuery(event.target.value); setOpen(true); setActive(0)
          // Escribir invalida la selección previa hasta elegir una opción.
          if (value) onChange('')
        }}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      <input type="hidden" name={name} value={value} />
      {open && (
        <ul id={listboxId} className="ui-combobox__listbox" role="listbox">
          {visible.map((option, index) => (
            <li
              key={option.value}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              className={`ui-combobox__option${index === activeIndex ? ' ui-combobox__option--active' : ''}`}
              // mousedown evita el blur del input antes de seleccionar.
              onMouseDown={(event) => { event.preventDefault(); select(option) }}
              onMouseEnter={() => setActive(index)}
            >
              {option.label}
            </li>
          ))}
          {visible.length === 0 && <li className="ui-combobox__note" role="presentation">Sin coincidencias.</li>}
          {matches.length > visible.length && (
            <li className="ui-combobox__note" role="presentation">
              Mostrando {visible.length} de {matches.length}. Sigue escribiendo para acotar.
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
