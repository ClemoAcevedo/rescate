# Demo de entrega y recorridos

La demo final se presenta en producción con cuentas y lotes ficticios del establecimiento
«Panadería Demo Rescate». Recorre RF01 a RF13 con tres cuentas separadas: publicación con
foto, búsqueda, reserva, espera con oferta, cancelación, chat, retiro, una incidencia
después de entregar, vencimientos y el panel. Cada paso usa las funciones del
[manual](manual.md). Los recorridos moderados con personas siguen el
[protocolo de accesibilidad](accesibilidad.md#protocolo-de-cinco-recorridos) en una
instancia local.

## Cuentas

| Cuenta | Rol en la demo |
| --- | --- |
| `operador.e3@rescate.test` | Operador de «Panadería Demo Rescate»: publica, chatea, valida el retiro, gestiona la incidencia y abre el panel |
| `persona.a.e3@rescate.test` | Persona A: reserva el lote completo y luego cancela |
| `persona.b.e3@rescate.test` | Persona B: espera, acepta la oferta, chatea, retira y reporta un problema |

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

**Antes del día.** Ensayar el guion completo, primero en local (ver más abajo) y luego en
producción, y grabarlo como respaldo. El ensayo en producción confirma que las tres
sesiones desde una misma red no alcanzan los [límites de tráfico](seguridad.md#límites).
Tener a mano una foto del pack (JPEG, PNG o WebP de hasta 5 MiB).

`npm --prefix api run demo` prepara datos por la API pública con las cuentas de la demo,
igual que la web. Exige `WEB_URL` (el origen HTTPS, sin ruta) y `DEMO_PASSWORD`, y se
detiene si el establecimiento ya tiene un lote con la ventana abierta, para que el panel y
la búsqueda muestren un solo lote durante el guion. `--foto` agrega una foto antes de
publicar.

```bash
WEB_URL=https://rescate-rescate1.vercel.app DEMO_PASSWORD='…' \
  npm --prefix api run demo -- previo --foto pan.jpg
```

**Al menos una hora antes.** El panel muestra por defecto los últimos 7 días con hoy
incluido y solo cuenta lotes cerrados ([panel](panel.md)). `previo` publica un lote de 2
packs cuya ventana termina en 20 minutos (`--minutos`): A reserva 1 pack y el operador
registra su retiro; B reserva el otro y no lo retira. Al cerrar, B tiene una reserva
«Vencida» (RF08) y el período muestra ese lote: 1 pack retirado, 1 no asignable, una
reserva retirada y una vencida.

**Minutos antes.** Abrir una ventana privada o un perfil de navegador por cuenta, con la
sesión iniciada: A y B en ancho móvil, el operador en escritorio. Si no habrá tiempo para
publicar en vivo, `en-vivo` deja publicado el lote del guion (2 packs, ventana de 3 horas,
`--horas`) con los 2 packs reservados por A: el paso 2 se muestra sobre ese lote ya
publicado y el paso 3 sobre la reserva ya hecha.

## Guion

| Paso | Quién | Qué se muestra | RF |
| --- | --- | --- | --- |
| 1. Cuentas | Todos | «Registro» muestra el consentimiento del correo sin enviarlo. El operador ve el grupo «Mi establecimiento» en el menú; A y B no. | RF01 |
| 2. Publicación | Operador | «Publicar lote»: 2 packs, una ventana que ya comenzó y termina después de la presentación. «Guardar borrador», «Agregar foto» hasta que deja de estar «En validación», «Publicar lote» y «Confirmar publicación». Publicado, el lote queda fijo. | RF02 |
| 3. Búsqueda y reserva | A | «Explorar lotes» con la ubicación o la categoría; el detalle con foto, «Tu retiro» y condiciones. «Reservar 2 packs» y «Ver mi código de retiro». | RF03, RF04 |
| 4. Espera | B | El lote muestra «Sin packs libres». «Unirme a la lista de espera» por 1 pack; «Mis esperas» muestra su lugar. La espera no retiene packs. | RF07 |
| 5. Cancelación y oferta | A, luego B | A elige «Cancelar reserva» y «Confirmar cancelación»; el código deja de servir. B recibe la oferta en «Avisos» con su plazo de diez minutos y elige «Aceptar 1 pack». | RF05, RF07, RF09 |
| 6. Chat | B y operador | B abre «Chat de la reserva» y escribe. El operador recibe el aviso del mensaje y responde desde «Avisos» o los compromisos de «Mi establecimiento». | RF13, RF09 |
| 7. Retiro | Operador | «Validar retiros»: escribe el código que muestra B, «Revisar código» y «Confirmar retiro de 1 pack». La conversación queda cerrada. | RF06 |
| 8. Incidencia | B, operador, A | B elige «Reportar un problema» en su reserva retirada. El operador la ve en «Incidencias por revisar», la publica con instrucciones y ve los avisos pendientes, generados y leídos. B (con entrega) y A (sin entrega) reciben el «Aviso de incidencia»; B lo marca como leído. El operador elige «Resolver incidencia». | RF11, RF09 |
| 9. Vencimiento | B | «Mis reservas» muestra la reserva de `previo` como «Vencida», sin código. | RF08 |
| 10. Panel | Operador | «Mi establecimiento»: el lote con 1 pack retirado y 1 libre, compromisos e historial de la sesión, y los resultados del período con las tasas de retiro y de vencimiento. | RF10, RF12 |

La oferta vence a los diez minutos. Si vence, B pierde su lugar y vuelve a unirse a la
espera; A puede reservar de nuevo para repetir el paso 5. Para mostrar un estado de error,
tras el paso 7 la conversación responde «Conversación cerrada…» y revisar el mismo código
muestra la reserva como «Retirada».

## Fuera de la demo

No se muestran ni se anuncian como disponibles:

- Recuperación de contraseña y administración de establecimientos y memberships desde
  la aplicación.
- Coordenadas precargadas o elegidas en un mapa ([#97](https://github.com/ClemoAcevedo/rescate/issues/97)).

## Ensayo local

La instancia de los recorridos sirve para ensayar el guion sin tocar producción. Las cuentas
cambian, pero los pasos son los mismos:

1. `npm --prefix api run recorridos:e3` levanta la instancia en `https://localhost:5174`
   (ver [recorridos moderados](#recorridos-moderados)) e imprime la contraseña local.
2. `preparar P01` y luego `preparar P02` registran `participante.p01@example.test` (A) y
   `participante.p02@example.test` (B). El operador es `operador.recorridos@example.test`,
   de «Panadería de prueba».
3. Se recorre el guion desde el paso 1 en tres ventanas. Los dos lotes de `preparar P02`
   siguen visibles en «Explorar lotes»; el guion usa el que publica el operador en el paso 2.
4. Los pasos 9 y 10 dependen de `previo`, que solo se prepara en producción: en local, el
   vencimiento se ve al publicar un lote con una ventana corta y esperar su cierre.
5. `salir` detiene los servicios.

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
