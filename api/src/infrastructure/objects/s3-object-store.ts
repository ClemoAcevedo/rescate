// K014 · Infrastructure: bucket privado S3 compatible (B2 según K005). Las claves y
// credenciales nunca salen del backend; no se emiten URLs firmadas.

import {
  DeleteObjectCommand, GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3"
import type { ObjectStore } from "../../application/photos/ports.js"

export interface S3Configuration {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

const PREFIX = "lot-photos/"

export function createS3ObjectStore(configuration: S3Configuration): ObjectStore {
  const client = new S3Client({
    endpoint: configuration.endpoint,
    region: configuration.region,
    credentials: { accessKeyId: configuration.accessKeyId, secretAccessKey: configuration.secretAccessKey },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  })
  const Bucket = configuration.bucket
  const options = () => ({ abortSignal: AbortSignal.timeout(30_000) })
  return {
    async put(key, bytes, contentType) {
      await client.send(new PutObjectCommand({
        Bucket, Key: PREFIX + key, Body: bytes, ContentType: contentType, CacheControl: "no-store",
      }), options())
    },
    async get(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket, Key: PREFIX + key }), options())
        return object.Body ? await object.Body.transformToByteArray() : null
      } catch (error) {
        if (error instanceof Error && error.name === "NoSuchKey") return null
        throw error
      }
    },
    async remove(key) {
      // B2 versiona: DELETE sin VersionId deja un marcador y conserva los bytes (K005).
      const Key = PREFIX + key
      const listed = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix: Key }), options())
      const versions = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].filter((version) => version.Key === Key)
      if (versions.length === 0) {
        await client.send(new DeleteObjectCommand({ Bucket, Key }), options())
        return
      }
      for (const version of versions) {
        await client.send(new DeleteObjectCommand({ Bucket, Key, VersionId: version.VersionId }), options())
      }
    },
  }
}
