// K006: infraestructura inicial. No consulta la base ni ejecuta trabajos.
console.log("Worker K006 iniciado: infraestructura inactiva, sin trabajos configurados")

// Mantiene el proceso disponible sin polling, consultas ni logs periódicos.
const keepAlive = setInterval(() => {}, 24 * 60 * 60 * 1000)

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`Worker K006 detenido por ${signal}`)
    clearInterval(keepAlive)
  })
}
