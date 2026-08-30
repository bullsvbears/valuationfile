/**
 * Generate the credentials a hosted deployment needs.
 *
 *   npm run hash-password                        generate a strong password
 *   npm run hash-password -- --out secrets.env   also write a file to import
 *   echo 'my own password' | npm run hash-password -- --stdin
 *
 * Prints an scrypt hash and a fresh session secret. Neither is stored here;
 * set them as secrets on the host.
 *
 * The hash uses the conventional PHC layout, which separates its fields with
 * `$`. That is a metacharacter in most shells, so pasting the value into a
 * command is easy to get wrong and a mangled secret fails as a wrong password
 * rather than as an error. `--out` writes a KEY=value file to pipe straight
 * into `fly secrets import`, which avoids quoting the value at all.
 *
 * A generated password is the default because this account is reached from a
 * password manager, not typed from memory, so there is nothing to gain from
 * choosing it yourself and a good deal to lose.
 */

import { randomBytes, randomInt } from 'node:crypto'
import { writeFileSync } from 'node:fs'
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

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main(): Promise<void> {
  const useStdin = process.argv.includes('--stdin')
  const outFile = flag('out')
  const password = useStdin ? await readStdin() : generatePassword()

  if (!password) throw new Error('No password on stdin.')
  if (password.length < MIN_LENGTH) {
    throw new Error(`Use at least ${MIN_LENGTH} characters; this one has ${password.length}.`)
  }

  if (!useStdin) {
    console.log('\nYour password (save it to a password manager - it is not stored anywhere):\n')
    console.log(`  ${password}\n`)
  }

  const hash = hashPassword(password)
  const sessionSecret = randomBytes(32).toString('hex')

  if (outFile) {
    writeFileSync(
      outFile,
      `DASHBOARD_PASSWORD_HASH=${hash}\nSESSION_SECRET=${sessionSecret}\n`,
      'utf8',
    )
    console.log(`Wrote ${outFile}. Load it into Fly without quoting anything:\n`)
    console.log(`  Get-Content ${outFile} | fly secrets import      # PowerShell`)
    console.log(`  fly secrets import < ${outFile}                  # bash / zsh\n`)
    console.log('Delete the file once the secrets are set; it holds a live credential.')
    return
  }

  console.log('Set these on your host, then redeploy:\n')
  console.log(`  DASHBOARD_PASSWORD_HASH=${hash}`)
  console.log(`  SESSION_SECRET=${sessionSecret}`)
  console.log('\nThe hash contains $ characters. Quote it with single quotes, or')
  console.log('avoid quoting entirely by rerunning with --out:\n')
  console.log('  npm run hash-password -- --out secrets.env\n')
  console.log('Rotating SESSION_SECRET signs out every existing session.')
}

// Piping this into `head` closes stdout early; that is not an error worth a
// stack trace, especially from a tool that prints a credential.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
})

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
