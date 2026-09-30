import { useId, type ReactNode } from 'react'

type FieldControlProps = {
  id: string
  required: boolean
  'aria-describedby'?: string
  'aria-invalid'?: true
}

type FormFieldProps = {
  id?: string
  label: string
  hint?: string
  error?: string
  required?: boolean
  children: (props: FieldControlProps) => ReactNode
}

/** Un único control nativo; propagar sus props para asociar etiqueta, ayuda y error. */
export function FormField({ id, label, hint, error, required = false, children }: FormFieldProps) {
  const generatedId = useId()
  const controlId = id ?? generatedId
  const descriptionId = `${controlId}-description`
  const description = error || hint

  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={controlId}>
        {label}{required && <span className="ui-field__required"> (obligatorio)</span>}
      </label>
      {children({
        id: controlId,
        required,
        'aria-describedby': description ? descriptionId : undefined,
        'aria-invalid': error ? true : undefined,
      })}
      {description && (
        <span id={descriptionId} className={`ui-field__description${error ? ' ui-field__description--error' : ''}`}>
          {description}
        </span>
      )}
    </div>
  )
}
