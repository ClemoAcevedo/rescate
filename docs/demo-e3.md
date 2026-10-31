# Demo de entrega y recorridos

La demo de E3 se presenta en producción con cuentas y lotes ficticios del
establecimiento «Panadería Demo Rescate». Muestra reserva, espera con oferta, chat y
retiro, y termina en el panel del establecimiento. Los recorridos moderados con
personas siguen el [protocolo de accesibilidad](accesibilidad.md#protocolo-de-cinco-recorridos)
en una instancia local.

## Cuentas

| Cuenta | Rol en la demo |
| --- | --- |
| `operador.e3@rescate.test` | Operador de «Panadería Demo Rescate»: publica, chatea, valida el retiro y abre el panel |
| `persona.a.e3@rescate.test` | Persona A: reserva el lote completo y luego cancela |
| `persona.b.e3@rescate.test` | Persona B: entra a la espera, acepta la oferta, chatea y retira |

Las tres usan la misma contraseña, que el equipo comparte por un canal privado; no se
guarda en el repositorio. El dominio `.test` no recibe correo, por lo que una
contraseña olvidada no se recupera: se registra otra cuenta.

Las cuentas se registran por la web o `POST /auth/register` y no obtienen permisos.
La membership del operador se crea con SQL desde la consola del servicio `postgres` en
Railway, porque la API no administra establecimientos ([despliegue](despliegue.md)):

```sql
INSERT INTO memberships (user_id, establishment_id)
SELECT u.id, e.id FROM users u, establishments e
WHERE u.email = 'operador.e3@rescate.test' AND e.name = 'Panadería Demo Rescate';
```

Las demás cuentas de producción no se usan en la demo. La de smoke pertenece al
pipeline de despliegue.

## Preparación

**Antes del día.** Ensayar el guion completo en producción y grabarlo como respaldo.
El ensayo confirma que las tres sesiones desde una misma red no alcanzan los
[límites de tráfico](seguridad.md#límites).

`npm --prefix api run demo:e3` prepara los lotes por la API pública con las cuentas
del operador y de A, igual que la web. Exige `WEB_URL` (el origen HTTPS, sin ruta) y
`DEMO_PASSWORD`, y se detiene si el establecimiento ya tiene un lote con la ventana
abierta, para que el panel y la búsqueda muestren un solo lote durante el guion.
`--foto` agrega una foto JPEG, PNG o WebP antes de publicar.

```bash
WEB_URL=https://rescate-rescate1.vercel.app DEMO_PASSWORD='…' \
  npm --prefix api run demo:e3 -- previo --foto pan.jpg
```

**Resultados del período.** El panel muestra por defecto los últimos 7 días con hoy
incluido y solo cuenta lotes cerrados ([panel](panel.md)). Con al menos una hora de
anticipación, `previo` publica un lote de 2 packs cuya ventana termina en 20 minutos
(`--minutos`), A reserva 1 pack y el operador registra su retiro. Al cerrar, el
período muestra ese lote: 1 pack retirado, 1 no asignable y la reserva retirada.

**Minutos antes.**

1. `en-vivo` publica el lote del guion: 2 packs, con una ventana que ya comenzó y
   termina en 3 horas (`--horas`). Retirar exige que la ventana haya comenzado, y una
   oferta no se emite con menos de un minuto de ventana. A reserva los 2 packs y el
   lote queda sin packs libres.
2. Abrir una ventana privada o un perfil de navegador por cuenta, con la sesión
   iniciada: A y B en ancho móvil, el operador en escritorio.

Para ensayar contra una instancia local, `WEB_URL=https://localhost:5174` con
`NODE_EXTRA_CA_CERTS` apuntando al certificado de Vite y las mismas cuentas y
membership en la base local.

## Guion

| Paso | Quién | Qué se muestra |
| --- | --- | --- |
| 1. Reserva | A | «Mis reservas» y el detalle: cantidad, lugar, ventana y código de retiro. |
| 2. Espera | B | «Explorar lotes»: el lote no tiene packs libres. «Unirme a la lista de espera», 1 pack y «Entrar voluntariamente a la espera»; «Mis esperas» muestra la posición. La espera no retiene packs. |
| 3. Cancelación y oferta | A, luego B | A elige «Cancelar reserva» y confirma; el código deja de servir. B recibe la oferta por 1 pack en su espera y en «Avisos», con su plazo de diez minutos, y la acepta. Aceptar crea su reserva y cierra la solicitud. |
| 4. Chat | B y operador | B usa «Abrir chat de la reserva» y escribe al establecimiento. El operador lo ve en «Avisos» o en los compromisos de «Mi establecimiento» y responde. |
| 5. Retiro | Operador | «Validar retiros» desde «Mis lotes»: escribe el código que muestra B, revisa la reserva y confirma la entrega. El chat queda cerrado. |
| 6. Panel | Operador | «Mi establecimiento»: el lote en vivo con 1 pack retirado y 1 libre, los compromisos de A y B, el historial de la sesión y los resultados del período. |

La oferta vence a los diez minutos. Si vence, B pierde la posición y debe volver a
entrar a la espera; el guion continúa con una nueva oferta.

## Fuera de la demo

No se muestran ni se anuncian como disponibles:

- Incidencias del lote y sus avisos en el panel ([#46](https://github.com/ClemoAcevedo/rescate/issues/46), [#48](https://github.com/ClemoAcevedo/rescate/issues/48)).
- Recuperación de contraseña y administración de establecimientos y memberships desde
  la aplicación.
- Coordenadas precargadas o elegidas en un mapa ([#97](https://github.com/ClemoAcevedo/rescate/issues/97)).

## Recorridos moderados

Los cinco recorridos usan la consigna, las preguntas y la ficha del
[protocolo](accesibilidad.md#protocolo-de-cinco-recorridos), con participantes ajenos a
la implementación. Las fichas anonimizadas se guardan fuera de `docs/` y se enlazan
desde el PR.

`npm --prefix api run recorridos:e3` levanta la instancia en `https://localhost:5174`:
crea una base dedicada en el PostgreSQL de Compose (o en `DATABASE_URL`), la migra e
inicia API, worker y Vite con un certificado efímero que el navegador pide aceptar.
Registra el operador de «Panadería de prueba» y dos cuentas de apoyo, y espera
comandos en la terminal:

| Comando | Cuándo | Efecto |
| --- | --- | --- |
| `preparar P01` | Antes de cada sesión | Registra `participante.p01@example.test`, retira los lotes abiertos del participante anterior y publica dos: uno de 6 packs disponible y otro de 10 sin packs libres, reservado por las cuentas de apoyo (4 + 6). |
| `ofrecer P01` | Justo antes del recorrido 5 | Cancela la reserva de apoyo de 4 packs; la cola ofrece esos 4 de los 10 que pidió el participante en el recorrido 4. Falla si el participante no está esperando. |
| `salir` | Al terminar | Detiene los servicios y conserva la base. Ctrl+C hace lo mismo. |

Todas las cuentas usan la contraseña pública que imprime el comando; existen solo en
esa base. El moderador inicia la sesión del participante antes de empezar y no
registra la contraseña ni el código de retiro en la ficha. La oferta dura diez
minutos y el worker la vence a su hora; si vence, se repiten los recorridos 4 y 5 con
`preparar`.
