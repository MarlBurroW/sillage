import { hash, verify } from '@node-rs/argon2'

export function hashPassword(password: string): Promise<string> {
  return hash(password)
}

export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  try {
    return await verify(digest, password)
  } catch {
    // Corrupt or unknown digest formats must not crash login routes,
    // but must never authenticate either.
    return false
  }
}
