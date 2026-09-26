import { useMemo } from 'react'
import type { OperableEstablishment } from '../../services/identity-service'
import { acceptDecimal, acceptInteger, type LotField, type LotFieldErrors, type LotFormValues } from '../../lots/lot-form'
import { supportedTimeZones } from '../../lots/lot-time'
import { Combobox } from '../ui/Combobox'
import { Input, Textarea } from '../ui/FormControls'
import { FormField } from '../ui/FormField'
import { UseCurrentLocation } from './UseCurrentLocation'

type LotFormFieldsProps = {
  values: LotFormValues
  errors: LotFieldErrors
  disabled: boolean
  onChange: (field: LotField, value: string) => void
  /** Solo al crear: el establecimiento no se reasigna después (OpenAPI). */
  establishment?: {
    options: OperableEstablishment[]
    value: string
    onChange: (value: string) => void
  }
}

/**
 * Campos de la declaración del lote; la página decide envío, estado y resultado.
 * Los numéricos son texto que ignora cambios no numéricos: type="number" admite «e», «+» y «-» en Chrome y
 * cualquier texto en Safari/Firefox. Las coordenadas no usan inputMode="decimal"
 * porque el teclado de iOS no ofrece el signo menos.
 */
export function LotFormFields({ values, errors, disabled, onChange, establishment }: LotFormFieldsProps) {
  const timeZones = useMemo(() => {
    const zones = supportedTimeZones()
    const withCurrent = values.timeZone && !zones.includes(values.timeZone) ? [values.timeZone, ...zones] : zones
    return withCurrent.map((zone) => ({ value: zone, label: zone }))
  }, [values.timeZone])
  const bind = (field: LotField, accept: (value: string) => string | null = (value) => value) => ({
    name: field,
    value: values[field],
    disabled,
    // Un cambio rechazado no actualiza el estado: el campo controlado conserva el valor anterior.
    onChange: (event: { target: { value: string } }) => {
      const accepted = accept(event.target.value)
      if (accepted !== null) onChange(field, accepted)
    },
  })

  return (
    <>
      {establishment && (
        <FormField label="Establecimiento" hint="Escribe para filtrar. El lote queda asociado a este establecimiento y no se puede cambiar después." error={errors.establishmentId} required>
          {(control) => (
            <Combobox
              {...control}
              name="establishmentId"
              placeholder="Busca por nombre"
              options={establishment.options.map((option) => ({ value: option.id, label: option.name }))}
              value={establishment.value}
              disabled={disabled}
              onChange={establishment.onChange}
            />
          )}
        </FormField>
      )}

      <fieldset className="lot-form__group" disabled={disabled}>
        <legend>Contenido</legend>
        <FormField label="Descripción del pack" hint="Qué contiene cada pack. Máximo 2000 caracteres." error={errors.description} required>
          {(control) => <Textarea {...control} {...bind('description')} maxLength={2000} />}
        </FormField>
        <div className="lot-form__row">
          <FormField label="Categoría" hint="Texto libre, por ejemplo Panadería." error={errors.category} required>
            {(control) => <Input {...control} {...bind('category')} />}
          </FormField>
          <FormField label="Cantidad de packs" hint="Packs equivalentes e indivisibles." error={errors.quantity} required>
            {(control) => <Input {...control} {...bind('quantity', acceptInteger)} inputMode="numeric" autoComplete="off" />}
          </FormField>
        </div>
        <FormField label="Condiciones de retiro" hint="Opcional, por ejemplo traer una bolsa." error={errors.conditions}>
          {(control) => <Textarea {...control} {...bind('conditions')} rows={2} />}
        </FormField>
      </fieldset>

      <fieldset className="lot-form__group" disabled={disabled}>
        <legend>Lugar de retiro</legend>
        <FormField label="Dirección" error={errors.address} required>
          {(control) => <Input {...control} {...bind('address')} autoComplete="street-address" />}
        </FormField>
        <div className="lot-form__row">
          <FormField label="Latitud" hint="Grados WGS84, entre -90 y 90." error={errors.latitude} required>
            {(control) => <Input {...control} {...bind('latitude', acceptDecimal)} autoComplete="off" />}
          </FormField>
          <FormField label="Longitud" hint="Grados WGS84, entre -180 y 180." error={errors.longitude} required>
            {(control) => <Input {...control} {...bind('longitude', acceptDecimal)} autoComplete="off" />}
          </FormField>
        </div>
        <UseCurrentLocation disabled={disabled} onLocate={(latitude, longitude) => { onChange('latitude', latitude); onChange('longitude', longitude) }} />
      </fieldset>

      <fieldset className="lot-form__group" disabled={disabled}>
        <legend>Ventana de retiro</legend>
        <FormField label="Zona horaria del lugar" hint="Escribe para filtrar, por ejemplo Santiago. Las horas de abajo se interpretan en esta zona." error={errors.timeZone} required>
          {(control) => (
            <Combobox
              {...control}
              name="timeZone"
              placeholder="Busca una zona horaria"
              options={timeZones}
              value={values.timeZone}
              disabled={disabled}
              onChange={(zone) => onChange('timeZone', zone)}
            />
          )}
        </FormField>
        <div className="lot-form__row">
          <FormField label="Inicio del retiro" error={errors.pickupStartsAt} required>
            {(control) => <Input {...control} {...bind('pickupStartsAt')} type="datetime-local" />}
          </FormField>
          <FormField label="Cierre del retiro" hint="Debe ser posterior al inicio." error={errors.pickupEndsAt} required>
            {(control) => <Input {...control} {...bind('pickupEndsAt')} type="datetime-local" />}
          </FormField>
        </div>
      </fieldset>
    </>
  )
}
