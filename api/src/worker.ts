// Worker: proceso separado de la API que registra vencimientos de lotes, reservas y
// ofertas (K028), genera los avisos del outbox (K030), valida fotos y limpia objetos (K014)
// y borra a diario el texto de los chats vencidos (K037).
import { createWorker } from "./composition.js"

const worker = createWorker()
if (worker === null) {
  // Sin DATABASE_URL no hay trabajos.
  console.log("Worker iniciado: inactivo, sin trabajos configurados")
  const keepAlive = setInterval(() => {}, 24 * 60 * 60 * 1000)
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log(`Worker detenido por ${signal}`)
      clearInterval(keepAlive)
    })
  }
} else {
  console.log(`Worker iniciado: ${worker.tasks.join("; ")}`)
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    // Termina el trabajo en curso; un lote, una foto o una tanda de avisos interrumpidos
    // se retoman al vencer su concesión.
    process.once(signal, () => {
      console.log(`Worker detenido por ${signal}`)
      worker.stop()
    })
  }
  await worker.run()
}
