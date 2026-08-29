/**
 * Generate the credentials a hosted deployment needs.
 *
 *   npm run hash-password                 generate a strong password
 *   echo 'my own password' | npm run hash-password -- --stdin
 *
 * Prints an scrypt hash and a fresh session secret. Neither is stored here;
 * set them as secrets on the host.
 *
 * A generated password is the default because this account is reached from a
 * password manager, not typed from memory, so there is nothing to gain from
 * choosing it yourself and a good deal to lose.
 */

import { randomBytes, randomInt } from 'node:crypto'
import { hashPassword } from '../server/auth.js'

const MIN_LENGTH = 12
const GENERATED_LENGTH = 24

// Ambiguous glyphs are excluded so the password survives being read aloud or
// retyped from a screenshot.
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_'

function generatePassword(): string {
  let out = ''
  for (let i = 0; i < GENERATED_LENGTH; i += 1) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8').trim()
}

async function main(): Promise<void> {
  const useStdin = process.argv.includes('--stdin')
  const password = useStdin ? await readStdin() : generatePassword()

  if (!password) throw new Error('No password on stdin.')
  if (password.length < MIN_LENGTH) {
    throw new Error(`Use at least ${MIN_LENGTH} characters; this one has ${password.length}.`)
  }

  if (!useStdin) {
    console.log('\nYour password (save it to a password manager - it is not stored anywhere):\n')
    console.log(`  ${password}\n`)
  }

  console.log('Set these on your host, then redeploy:\n')
  console.log(`  DASHBOARD_PASSWORD_HASH='${hashPassword(password)}'`)
  console.log(`  SESSION_SECRET='${randomBytes(32).toString('hex')}'`)
  console.log('\nOn Fly.io:\n')
  console.log("  fly secrets set DASHBOARD_PASSWORD_HASH='...' SESSION_SECRET='...'\n")
  console.log('Rotating SESSION_SECRET signs out every existing session.')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
