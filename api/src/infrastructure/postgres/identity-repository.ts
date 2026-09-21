import type { EmailCanonicalizer, IdentityRepository, IdentityUser, PasswordCredential } from "../../application/identity/ports.js"
import { withTransaction } from "./pool.js"
import type { Pool } from "./pool.js"

interface AccountRow {
  id: string
  public_id: string
  email: string
  password_hash: Buffer | null
  password_salt: Buffer | null
  scrypt_n: number | null
  scrypt_r: number | null
  scrypt_p: number | null
}

const toUser = (row: Pick<AccountRow, "id" | "public_id" | "email">): IdentityUser =>
  ({ id: row.id, publicId: row.public_id, email: row.email })

export function createEmailCanonicalizer(pool: Pool): EmailCanonicalizer {
  return {
    async canonicalize(input) {
      const { rows } = await pool.query<{ email: string }>("SELECT public.canonicalize_email($1) AS email", [input])
      return rows[0]!.email
    },
  }
}

export function createIdentityRepository(pool: Pool): IdentityRepository {
  return {
    async findByEmail(email) {
      const { rows } = await pool.query<AccountRow>(`SELECT u.id::text, u.public_id::text, u.email,
        c.password_hash, c.password_salt, c.scrypt_n, c.scrypt_r, c.scrypt_p
        FROM public.users u LEFT JOIN public.user_credentials c ON c.user_id=u.id WHERE u.email=$1`, [email])
      const row = rows[0]
      if (!row) return null
      const credential: PasswordCredential | null = row.password_hash === null ? null : {
        hash: new Uint8Array(row.password_hash), salt: new Uint8Array(row.password_salt!),
        parameters: { N: row.scrypt_n!, r: row.scrypt_r!, p: row.scrypt_p! },
      }
      return { user: toUser(row), credential }
    },
    async listEstablishments(userId) {
      const { rows } = await pool.query<{ id: string; name: string }>(`SELECT e.public_id::text AS id, e.name
        FROM public.establishments e JOIN public.memberships m ON m.establishment_id=e.id
        WHERE m.user_id=$1 ORDER BY e.public_id`, [userId])
      return rows
    },
    async findUserById(userId) {
      const { rows } = await pool.query<AccountRow>("SELECT id::text, public_id::text, email FROM public.users WHERE id=$1", [userId])
      return rows[0] ? toUser(rows[0]) : null
    },
    async createUserWithCredential(email, credential) {
      try {
        return await withTransaction(pool, async client => {
          const { rows } = await client.query<AccountRow>(
            "INSERT INTO public.users(email) VALUES ($1) RETURNING id::text, public_id::text, email", [email])
          const user = toUser(rows[0]!)
          await client.query(`INSERT INTO public.user_credentials
            (user_id,password_hash,password_salt,scrypt_n,scrypt_r,scrypt_p) VALUES ($1,$2,$3,$4,$5,$6)`,
          [user.id, Buffer.from(credential.hash), Buffer.from(credential.salt),
            credential.parameters.N, credential.parameters.r, credential.parameters.p])
          return { kind: "created" as const, user }
        })
      } catch (error) {
        // Solo la restricción conocida es un conflicto de correo; otras fallas
        // conservan su naturaleza técnica, sin elegir aquí códigos HTTP.
        if (typeof error === "object" && error !== null && "code" in error && "constraint" in error
          && error.code === "23505" && error.constraint === "users_email_key") return { kind: "email_exists" }
        throw error
      }
    },
  }
}
