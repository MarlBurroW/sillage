import { hash, verify } from '@node-rs/argon2'

export function hashPassword(password: string): Promise<string> {
  return hash(password)
}

export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  try {
    return await verify(digest, password)
  } catch {
    // Un digest corrompu ou d'un format inconnu ne doit pas faire tomber la route de
    // login, mais ne doit jamais valider non plus.
    return false
  }
}
