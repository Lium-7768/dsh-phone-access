/**
 * The access password and the rate limit in front of it.
 *
 * The password guards a public URL that can execute code on this machine, so it
 * is long and random rather than memorable, it is compared in constant time, and
 * a caller that keeps guessing is locked out.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Failures allowed per client before a lock. */
const MAX_FAILURES = 5

/** How long a locked client waits, in milliseconds. */
const LOCK_MS = 60_000

/** Failures across all clients before the whole endpoint pauses. */
const MAX_GLOBAL_FAILURES = 40

/** One client's failure record. */
interface FailureRecord {
  count: number
  until: number
}

/** Reads or creates the password stored on disk. */
export class PasswordStore {
  readonly #path: string
  #value: string

  /**
   * @param path - File holding the password.
   */
  constructor(path: string) {
    this.#path = path
    this.#value = readOrCreate(path)
  }

  /** The password currently accepted. */
  get value(): string {
    return this.#value
  }

  /**
   * Replace the password and persist it. Every previously issued device
   * credential keeps working; rotate those with the registry when they must stop.
   *
   * @returns The new password.
   */
  rotate(): string {
    const next = generate()
    writeSecret(this.#path, next)
    this.#value = next
    return next
  }

  /**
   * Replace the password with one the operator chose.
   *
   * A password this endpoint accepts must be long enough to be worth the rate
   * limit in front of it, and printable so it survives being typed on a phone.
   *
   * @param candidate - The password to store.
   * @returns The stored password.
   * @throws {Error} When the password is too short, too long, or has whitespace.
   */
  set(candidate: string): string {
    const value = candidate.trim()
    const problem = passwordProblem(value)
    if (problem !== undefined) throw new Error(problem)
    writeSecret(this.#path, value)
    this.#value = value
    return value
  }

  /**
   * Compare a submitted password without leaking its length or content through
   * timing.
   *
   * @param candidate - Password the caller submitted.
   * @returns Whether it matches.
   */
  matches(candidate: string): boolean {
    const expected = Buffer.from(this.#value)
    const actual = Buffer.from(candidate)
    // timingSafeEqual throws on a length mismatch, so compare equal-length buffers
    // and fold the length difference into the result.
    const padded = Buffer.alloc(expected.length)
    actual.copy(padded, 0, 0, Math.min(actual.length, expected.length))
    const equal = timingSafeEqual(expected, padded)
    return equal && actual.length === expected.length
  }
}

/** Shortest password the section accepts; the generated one is 32 characters. */
export const MIN_PASSWORD_LENGTH = 16

/** Longest password the section accepts. */
export const MAX_PASSWORD_LENGTH = 128

/**
 * Check one candidate password.
 *
 * @param value - Trimmed password the operator typed.
 * @returns A message naming the first problem, or `undefined` when it is usable.
 */
export function passwordProblem(value: string): string | undefined {
  if (value.length < MIN_PASSWORD_LENGTH) return `密码至少需要 ${String(MIN_PASSWORD_LENGTH)} 个字符。`
  if (value.length > MAX_PASSWORD_LENGTH) return `密码最多 ${String(MAX_PASSWORD_LENGTH)} 个字符。`
  if (/\s/.test(value)) return '密码不能包含空格。'
  return undefined
}

/** Tracks failures per client and across the endpoint. */
export class AuthRateLimit {
  readonly #clients = new Map<string, FailureRecord>()
  #globalCount = 0
  #globalUntil = 0

  /**
   * @param key - Client identifier, normally a remote address.
   * @returns Whether the client must wait.
   */
  blocked(key: string): boolean {
    const now = Date.now()
    if (now < this.#globalUntil) return true
    const record = this.#clients.get(key)
    return record !== undefined && now < record.until
  }

  /**
   * Record one failure.
   *
   * @param key - Client identifier.
   */
  fail(key: string): void {
    const now = Date.now()
    const record = this.#clients.get(key) ?? { count: 0, until: 0 }
    record.count += 1
    if (record.count >= MAX_FAILURES) {
      record.until = now + LOCK_MS
      record.count = 0
    }
    this.#clients.set(key, record)
    this.#globalCount += 1
    if (this.#globalCount >= MAX_GLOBAL_FAILURES) {
      this.#globalUntil = now + LOCK_MS
      this.#globalCount = 0
    }
  }

  /**
   * Clear a client's failures after a success.
   *
   * @param key - Client identifier.
   */
  succeed(key: string): void {
    this.#clients.delete(key)
  }
}

/**
 * Generate one password: 32 URL-safe characters from 24 random bytes.
 *
 * @returns The generated password.
 */
function generate(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * Read the stored password, creating one when the file is absent.
 *
 * @param path - File holding the password.
 * @returns The password to accept.
 */
function readOrCreate(path: string): string {
  if (existsSync(path)) {
    const stored = readFileSync(path, 'utf8').trim()
    if (stored.length >= 16) return stored
  }
  const created = generate()
  writeSecret(path, created)
  return created
}

/**
 * Write a secret with owner-only permissions.
 *
 * @param path - Destination file.
 * @param value - Secret to write.
 */
function writeSecret(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${value}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}
