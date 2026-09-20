import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  GetBucketAclCommand, ListObjectVersionsCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Falta ${name}`)
  return value
}

export async function remoteSmoke(bytes: Buffer) {
  const endpoint = new URL(required("PHOTO_S3_ENDPOINT"))
  assert(endpoint.protocol === "https:" && !endpoint.username && !endpoint.password &&
    !endpoint.search && !endpoint.hash, "Endpoint HTTPS sin credenciales ni parámetros requerido")
  const Bucket = required("PHOTO_S3_BUCKET")
  const config = {
    endpoint: endpoint.href,
    region: required("PHOTO_S3_REGION"),
    credentials: {
      accessKeyId: required("PHOTO_S3_ACCESS_KEY_ID"),
      secretAccessKey: required("PHOTO_S3_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: true,
    // Evita versiones duplicadas por reintentos de PUT cuya respuesta se perdió.
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED" as const,
    responseChecksumValidation: "WHEN_REQUIRED" as const,
  }
  let client = new S3Client(config)
  const Key = `k005/${randomUUID()}.png`
  let attempted = false
  let version: string | undefined
  const sendOptions = () => ({ abortSignal: AbortSignal.timeout(30_000) })
  const versions = async () => {
    const result = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix: Key }), sendOptions())
    assert(!result.IsTruncated, "Listado de versiones inesperadamente truncado")
    return [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])].filter(v => v.Key === Key)
  }
  const http = (url: string) => fetch(url, {
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000),
  })
  const missing = async (VersionId?: string) => {
    try {
      const result = await client.send(new GetObjectCommand({ Bucket, Key, VersionId }), sendOptions())
      await result.Body?.transformToByteArray()
      assert.fail("Objeto recuperable después del borrado")
    } catch (error) {
      // Un 403, timeout o fallo de red NO demuestra inexistencia.
      assert(error instanceof Error &&
        ["NoSuchKey", "NoSuchVersion"].includes(error.name), "Se esperaba NoSuchKey/NoSuchVersion")
    }
  }
  console.log(JSON.stringify({ step: "start", key: Key }))
  try {
    const acl = await client.send(new GetBucketAclCommand({ Bucket }), sendOptions())
    assert(acl.Grants?.length && acl.Grants.every(g =>
      g.Grantee?.Type === "CanonicalUser" && g.Grantee.ID === acl.Owner?.ID),
    "El bucket debe conceder acceso solo a su propietario")
    assert.equal((await versions()).length, 0)
    console.log("PASS bucket privado (ACL sin concesiones públicas)")
    attempted = true
    const uploaded = await client.send(new PutObjectCommand({
      Bucket, Key, Body: bytes, ContentType: "image/png", CacheControl: "no-store",
    }), sendOptions())
    version = uploaded.VersionId
    assert(version, "B2 debe devolver VersionId; revisar limpieza")
    console.log("PASS upload; VersionId recibido")
    client.destroy()
    client = new S3Client(config)
    const object = await client.send(new GetObjectCommand({ Bucket, Key }), sendOptions())
    assert(object.Body)
    assert.deepEqual(Buffer.from(await object.Body.transformToByteArray()), bytes)
    console.log("PASS persistencia y lectura autenticada desde cliente nuevo; bytes idénticos")
    const signed = await getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn: 300 })
    const signedResponse = await http(signed)
    assert.equal(signedResponse.status, 200)
    assert.deepEqual(Buffer.from(await signedResponse.arrayBuffer()), bytes)
    console.log("PASS GET firmado 200; bytes idénticos (URL no registrada)")
    const unsigned = new URL(signed)
    unsigned.search = ""
    const anonymous = await http(unsigned.href)
    await anonymous.arrayBuffer()
    console.log(`HTTP GET anónimo: ${anonymous.status}`)
    assert([401, 403].includes(anonymous.status), "Se esperaba rechazo anónimo 401/403")
    console.log(`PASS GET anónimo ${anonymous.status} mientras el objeto existe`)
    const tampered = new URL(signed)
    const signature = tampered.searchParams.get("X-Amz-Signature")
    assert(signature)
    tampered.searchParams.set("X-Amz-Signature", (signature[0] === "0" ? "1" : "0") + signature.slice(1))
    const rejected = await http(tampered.href)
    await rejected.arrayBuffer()
    console.log(`HTTP GET firma alterada: ${rejected.status}`)
    assert([401, 403].includes(rejected.status), "Se esperaba rechazo de firma 401/403")
    console.log(`PASS firma alterada ${rejected.status}`)
    await client.send(new DeleteObjectCommand({ Bucket, Key, VersionId: version }), sendOptions())
    await missing()
    await missing(version)
    assert.equal((await versions()).length, 0)
    const deleted = await http(signed)
    await deleted.arrayBuffer()
    assert.equal(deleted.status, 404, "La URL previamente válida debe responder 404")
    console.log("PASS delete permanente; GET actual/versionado ausentes; URL anterior 404; cero versiones")
  } finally {
    try {
      if (attempted) {
        // También recupera un PUT aceptado cuya respuesta se perdió, solo para esta clave UUID.
        for (const item of await versions()) {
          assert(item.VersionId)
          await client.send(new DeleteObjectCommand({ Bucket, Key, VersionId: item.VersionId }), sendOptions())
        }
        assert.equal((await versions()).length, 0)
        console.log("PASS limpieza del objeto de prueba")
      }
    } catch {
      console.error(`Limpieza NO confirmada: revisar todas las versiones de ${Key} en el bucket de prueba`)
      process.exitCode = 1
    } finally {
      client.destroy()
    }
  }
}
