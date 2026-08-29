import { describe, expect, it } from 'vitest'
import {
  assertProductionAuth,
  authConfigFromEnv,
  hashPassword,
  issueSession,
  verifyPassword,
  verifySession,
} from '../server/auth.js'

describe('password hashing', () => {
  const password = 'correct-horse-battery-staple'
  const hash = hashPassword(password)

  it('accepts the right password', () => {
    expect(verifyPassword(password, hash)).toBe(true)
  })

  it('rejects the wrong password', () => {
    expect(verifyPassword('wrong-horse-battery-staple', hash)).toBe(false)
    expect(verifyPassword('', hash)).toBe(false)
  })

  it('salts each hash, so the same password never stores the same value', () => {
    expect(hashPassword(password)).not.toBe(hash)
    expect(verifyPassword(password, hashPassword(password))).toBe(true)
  })

  it('records its cost parameters so they can be raised later without a reset', () => {
    expect(hash.startsWith('scrypt$32768$8$2$')).toBe(true)
  })

  it('rejects a malformed or truncated stored hash instead of throwing', () => {
    for (const bad of ['', 'not-a-hash', 'scrypt$1$2$3', `${hash}$extra`, 'scrypt$x$y$z$q$r']) {
      expect(verifyPassword(password, bad)).toBe(false)
    }
  })
})

describe('session tokens', () => {
  const secret = 'a-test-session-secret'

  it('accepts a token it just issued', () => {
    expect(verifySession(issueSession(secret), secret)).toBe(true)
  })

  it('rejects a token signed with a different secret', () => {
    // This is what rotating SESSION_SECRET relies on to sign everyone out.
    expect(verifySession(issueSession(secret), 'a-different-secret')).toBe(false)
  })

  it('rejects a token whose expiry has been tampered with', () => {
    const token = issueSession(secret)
    const signature = token.split('.')[1]
    const farFuture = String(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)
    expect(verifySession(`${farFuture}.${signature}`, secret)).toBe(false)
  })

  it('rejects an expired token', () => {
    const issuedAt = Date.now() - 13 * 60 * 60 * 1000 // past the 12-hour life
    expect(verifySession(issueSession(secret, issuedAt), secret)).toBe(false)
  })

  it('rejects malformed tokens instead of throwing', () => {
    for (const bad of ['', '.', 'nodot', 'abc.def', '..']) {
      expect(verifySession(bad, secret)).toBe(false)
    }
  })
})

describe('configuration', () => {
  it('generates a per-process session secret when none is configured', () => {
    // Sessions then survive only until restart, which is the right default:
    // it fails closed rather than signing tokens with a predictable key.
    const a = authConfigFromEnv({})
    const b = authConfigFromEnv({})
    expect(a.sessionSecret).not.toBe(b.sessionSecret)
    expect(a.sessionSecret.length).toBeGreaterThanOrEqual(32)
  })

  it('sets secure cookies in production but not for a local HTTP run', () => {
    expect(authConfigFromEnv({ NODE_ENV: 'production' }).secureCookies).toBe(true)
    expect(authConfigFromEnv({}).secureCookies).toBe(false)
  })

  it('refuses to start unprotected in production', () => {
    const config = authConfigFromEnv({ NODE_ENV: 'production' })
    expect(() => assertProductionAuth(config, { NODE_ENV: 'production' })).toThrow(
      /DASHBOARD_PASSWORD_HASH/,
    )
  })

  it('allows an unprotected local run', () => {
    expect(() => assertProductionAuth(authConfigFromEnv({}), {})).not.toThrow()
  })

  it('allows production once a password is configured', () => {
    const env = { NODE_ENV: 'production', DASHBOARD_PASSWORD_HASH: hashPassword('a-password-here') }
    expect(() => assertProductionAuth(authConfigFromEnv(env), env)).not.toThrow()
  })
})
