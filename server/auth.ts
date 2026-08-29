import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * Single-user authentication.
 *
 * The dashboard carries licensed FactSet estimates and the analyst's own
 * models, so it must not be reachable by anyone who happens to find the URL.
 * There is exactly one account, configured by environment variable, which keeps
 * a user store out of a tool that only ever has one user.
 *
 *   DASHBOARD_PASSWORD_HASH   scrypt hash from `npm run hash-password`
 *   SESSION_SECRET            random string; rotating it signs everyone out
 */

const COOKIE_NAME = 'valuation_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // a trading day, then sign in again

/**
 * scrypt cost parameters.
 *
 * N=2^15 with p=2 is one of OWASP's recommended pairs. It needs 128*N*r = 32MB
 * per hash, which matters because the smallest hosted VMs have 256MB total; the
 * heavier N=2^16 variant needs 64MB and would make a login a memory event.
 *
 * Node caps scrypt at 32MB unless maxmem says otherwise, so it is set here with
 * headroom rather than left to the default.
 */
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 2, keylen: 64 } as const
const SCRYPT_MAXMEM = 192 * 1024 * 1024
const SALT_BYTES = 16

/** Brute-force limits, per source address. */
const MAX_ATTEMPTS = 8
const LOCKOUT_MS = 15 * 60 * 1000

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES)
  const derived = scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    ...SCRYPT_PARAMS,
    maxmem: SCRYPT_MAXMEM,
  })
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('hex')}$${derived.toString('hex')}`
}

/** Constant-time password check against a stored scrypt hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const [, n, r, p, saltHex, hashHex] = parts as [string, string, string, string, string, string]
  let expected: Buffer
  let actual: Buffer
  try {
    expected = Buffer.from(hashHex, 'hex')
    actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT_MAXMEM,
    })
  } catch {
    return false
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

/**
 * Sessions are a signed expiry rather than a server-side record, so a restart
 * or a second instance does not sign the user out. Rotating SESSION_SECRET
 * invalidates every outstanding session at once.
 */
export function issueSession(secret: string, now = Date.now()): string {
  const expiry = String(now + SESSION_TTL_MS)
  return `${expiry}.${sign(expiry, secret)}`
}

export function verifySession(token: string, secret: string, now = Date.now()): boolean {
  const [expiry, signature] = token.split('.')
  if (!expiry || !signature) return false

  const expected = Buffer.from(sign(expiry, secret))
  const provided = Buffer.from(signature)
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return false

  const expiresAt = Number(expiry)
  return Number.isFinite(expiresAt) && expiresAt > now
}

/** Minimal cookie header parsing; the app sets exactly one cookie. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() !== name) continue
    return decodeURIComponent(part.slice(index + 1).trim())
  }
  return undefined
}

class AttemptLimiter {
  private readonly attempts = new Map<string, { count: number; until: number }>()

  lockedUntil(key: string, now = Date.now()): number | null {
    const entry = this.attempts.get(key)
    if (!entry || entry.count < MAX_ATTEMPTS) return null
    if (entry.until > now) return entry.until
    this.attempts.delete(key)
    return null
  }

  fail(key: string, now = Date.now()): void {
    const entry = this.attempts.get(key) ?? { count: 0, until: 0 }
    entry.count += 1
    entry.until = now + LOCKOUT_MS
    this.attempts.set(key, entry)
  }

  succeed(key: string): void {
    this.attempts.delete(key)
  }
}

export interface AuthConfig {
  passwordHash: string | undefined
  sessionSecret: string
  /** Set the Secure cookie flag. Off for plain-HTTP local runs. */
  secureCookies: boolean
}

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  return {
    passwordHash: env.DASHBOARD_PASSWORD_HASH,
    // Without a configured secret, sessions are valid only for this process.
    sessionSecret: env.SESSION_SECRET ?? randomBytes(32).toString('hex'),
    secureCookies: env.NODE_ENV === 'production' && env.INSECURE_COOKIES !== 'true',
  }
}

/**
 * Reject cross-site state-changing requests.
 *
 * The session rides in a cookie, so a page on another origin could otherwise
 * make the browser issue writes. SameSite=Lax already blocks the common cases;
 * checking Origin closes the rest without needing a CSRF token round-trip.
 */
function sameOrigin(req: Request): boolean {
  const origin = req.get('origin')
  if (!origin) return true // same-origin non-CORS requests may omit it entirely
  try {
    return new URL(origin).host === req.get('host')
  } catch {
    return false
  }
}

export function createAuth(config: AuthConfig) {
  const limiter = new AttemptLimiter()
  const enabled = Boolean(config.passwordHash)

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.secureCookies,
    maxAge: SESSION_TTL_MS,
    path: '/',
  }

  /** Gate every API route. With no password configured the app stays open. */
  const requireSession: RequestHandler = (req, res, next) => {
    if (!enabled) return next()

    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      res.status(403).json({ error: 'Cross-origin request refused' })
      return
    }

    const token = readCookie(req.headers.cookie, COOKIE_NAME)
    if (token && verifySession(token, config.sessionSecret)) return next()

    res.status(401).json({ error: 'Not signed in' })
  }

  const login = (req: Request, res: Response): void => {
    if (!enabled) {
      res.json({ ok: true, authRequired: false })
      return
    }

    const key = req.ip ?? 'unknown'
    const lockedUntil = limiter.lockedUntil(key)
    if (lockedUntil) {
      res.status(429).json({
        error: `Too many attempts. Try again in ${Math.ceil((lockedUntil - Date.now()) / 60000)} minutes.`,
      })
      return
    }

    const password = (req.body as { password?: unknown })?.password
    if (typeof password !== 'string' || !verifyPassword(password, config.passwordHash as string)) {
      limiter.fail(key)
      res.status(401).json({ error: 'Incorrect password' })
      return
    }

    limiter.succeed(key)
    res.cookie(COOKIE_NAME, issueSession(config.sessionSecret), cookieOptions)
    res.json({ ok: true, authRequired: true })
  }

  const logout = (_req: Request, res: Response): void => {
    res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: undefined })
    res.json({ ok: true })
  }

  /** Whether the caller is signed in, so the UI knows to show the login form. */
  const session = (req: Request, res: Response): void => {
    const token = readCookie(req.headers.cookie, COOKIE_NAME)
    res.json({
      authRequired: enabled,
      signedIn: !enabled || Boolean(token && verifySession(token, config.sessionSecret)),
    })
  }

  return { enabled, requireSession, login, logout, session }
}

/** Fail loudly rather than silently serving an unprotected app in production. */
export function assertProductionAuth(config: AuthConfig, env = process.env): void {
  if (env.NODE_ENV !== 'production' || config.passwordHash) return
  throw new Error(
    'DASHBOARD_PASSWORD_HASH is not set. Generate one with `npm run hash-password` ' +
      'and set it before deploying, or set ALLOW_OPEN_ACCESS=true to override.',
  )
}

export type { NextFunction }
