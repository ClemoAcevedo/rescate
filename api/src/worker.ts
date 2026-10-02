// Worker: proceso separado de la API que valida fotos y limpia objetos (K014).
import { createPhotoWorker } from "./composition.js"

const worker = createPhotoWorker()
if (worker === null) {
  // Sin DATABASE_URL o PHOTO_STORAGE no hay trabajos que ejecutar.
  console.log("Worker iniciado: inactivo, sin base ni almacenamiento de fotos configurados")
  const keepAlive = setInterval(() => {}, 24 * 60 * 60 * 1000)
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log(`Worker detenido por ${signal}`)
      clearInterval(keepAlive)
    })
  }
} else {
  console.log("Worker iniciado: validación y limpieza de fotos")
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    // Termina la foto en curso; una validación interrumpida se retoma al vencer su reclamo.
    process.once(signal, () => {
      console.log(`Worker detenido por ${signal}`)
      worker.stop()
    })
  }
  await worker.run()
}
