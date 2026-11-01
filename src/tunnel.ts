/**
 * Cloudflare quick tunnel in front of the front listener.
 *
 * A quick tunnel needs no account and no DNS: cloudflared opens an outbound
 * connection and prints one `https://<random>.trycloudflare.com` address. The
 * address changes every start, which is why the plugin publishes it instead of
 * the user configuring it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where a downloaded binary is kept when the system has none. */
const CACHE_PATH = join(homedir(), '.dsh', 'mobile-bridge', 'cloudflared')

/** Official quick-tunnel host pattern. */
const PUBLIC_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

/** How many trailing cloudflared lines a failure report keeps. */
const TAIL_LINES = 6

/**
 * Keeps the last few lines cloudflared printed.
 *
 * A tunnel can fail before it ever reports an address — a proxy that drops the
 * edge connection, a tunnel that no longer exists in the account, a blocked REST
 * call. The message that says which one is in cloudflared's own output, so the
 * thrown error carries it instead of a generic timeout.
 */
class OutputTail {
  readonly #lines: string[] = []

  /** @param chunk - One stdout or stderr chunk. */
  push(chunk: Buffer): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      const trimmed = line.trim()
      // Timestamped INFO noise says nothing a reader needs; keep the diagnosis.
      if (trimmed === '' || /^\d{4}-\d{2}-\d{2}T\S+ INF /.test(trimmed)) continue
      this.#lines.push(trimmed)
      if (this.#lines.length > TAIL_LINES) this.#lines.shift()
    }
  }

  /** @returns The retained lines, joined for one error message. */
  get summary(): string {
    return this.#lines.length === 0 ? '' : ` (cloudflared: ${this.#lines.join(' | ')})`
  }
}

/** A running tunnel. */
export interface TunnelHandle {
  /** Public base URL, once cloudflared reported it. */
  publicUrl: string
  /** Stop the tunnel. */
  stop: () => void
}

/**
 * Find a cloudflared binary, downloading one when the system has none.
 *
 * @param log - Reports progress and failures.
 * @returns The binary path, or `undefined` when it cannot be provided.
 */
export function resolveCloudflared(log: (message: string) => void): string | undefined {
  const onPath = spawnSync('which', ['cloudflared'], { encoding: 'utf8' })
  if (onPath.status === 0 && onPath.stdout.trim() !== '') return onPath.stdout.trim()
  if (existsSync(CACHE_PATH)) return CACHE_PATH
  log('cloudflared not found; downloading it once into ~/.dsh/mobile-bridge')
  mkdirSync(join(homedir(), '.dsh', 'mobile-bridge'), { recursive: true })
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`
  const work = join(homedir(), '.dsh', 'mobile-bridge', 'cloudflared.tgz')
  const download = spawnSync('curl', ['-fsSL', '--max-time', '180', '-o', work, url], { encoding: 'utf8' })
  if (download.status !== 0) {
    log(`could not download cloudflared: ${download.stderr.trim().slice(0, 200)}`)
    return undefined
  }
  const extract = spawnSync('tar', ['-xzf', work, '-C', join(homedir(), '.dsh', 'mobile-bridge')], { encoding: 'utf8' })
  rmSync(work, { force: true })
  if (extract.status !== 0 || !existsSync(CACHE_PATH)) {
    log(`could not unpack cloudflared: ${extract.stderr.trim().slice(0, 200)}`)
    return undefined
  }
  chmodSync(CACHE_PATH, 0o755)
  return CACHE_PATH
}

/**
 * Start a quick tunnel to one local port and wait for its public address.
 *
 * @param options - Local port, log sink, and how long to wait for the address.
 * @returns The running tunnel.
 * @throws {Error} When cloudflared exits or never reports an address.
 */
export async function startTunnel(options: {
  port: number
  log: (message: string) => void
  timeoutMs?: number
}): Promise<TunnelHandle> {
  const binary = resolveCloudflared(options.log)
  if (binary === undefined) throw new Error('cloudflared is unavailable')
  const child: ChildProcess = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${options.port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tail = new OutputTail()
  const publicUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`cloudflared did not report an address in time${tail.summary}`)),
      options.timeoutMs ?? 60_000,
    )
    const scan = (chunk: Buffer): void => {
      tail.push(chunk)
      const match = PUBLIC_URL.exec(chunk.toString('utf8'))
      if (match === null) return
      clearTimeout(timer)
      resolve(match[0])
    }
    child.stdout?.on('data', scan)
    child.stderr?.on('data', scan)
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`cloudflared exited with ${String(code)}${tail.summary}`))
    })
  }).catch(error => {
    child.kill('SIGTERM')
    throw error
  })
  return {
    publicUrl,
    stop: () => {
      child.kill('SIGTERM')
    },
  }
}

/** A named tunnel, bound to a hostname in the account instead of a random one. */
export interface NamedTunnelOptions {
  /** Tunnel name or id created by `cloudflared tunnel create`. */
  name: string
  /** Public hostname routed to this tunnel. */
  hostname: string
  /** Local port the tunnel forwards to. */
  port: number
  /** Reports progress and failures. */
  log: (message: string) => void
  /** How long to wait for the first registered connection. */
  timeoutMs?: number
}

/**
 * Start a named tunnel whose hostname never changes.
 *
 * A quick tunnel prints a fresh `trycloudflare.com` address on every start, which
 * makes a saved address useless. A named tunnel is created once in the account and
 * routed to one hostname, so the phone keeps working across restarts.
 *
 * @param options - Tunnel name, hostname, and local port.
 * @returns The running tunnel with its stable public address.
 * @throws {Error} When cloudflared exits or never connects.
 */
export async function startNamedTunnel(options: NamedTunnelOptions): Promise<TunnelHandle> {
  const binary = resolveCloudflared(options.log)
  if (binary === undefined) throw new Error('cloudflared is unavailable')
  const child: ChildProcess = spawn(
    binary,
    ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${options.port}`, 'run', options.name],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const tail = new OutputTail()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`named tunnel did not connect in time${tail.summary}`)),
      options.timeoutMs ?? 60_000,
    )
    const settle = (error?: Error): void => {
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }
    // cloudflared logs `Registered tunnel connection` once an edge accepts it.
    const scan = (chunk: Buffer): void => {
      tail.push(chunk)
      if (chunk.toString('utf8').includes('Registered tunnel connection')) settle()
    }
    child.stdout?.on('data', scan)
    child.stderr?.on('data', scan)
    child.once('exit', code => settle(new Error(`cloudflared exited with ${String(code)}${tail.summary}`)))
  }).catch(error => {
    child.kill('SIGTERM')
    throw error
  })
  return {
    publicUrl: `https://${options.hostname}`,
    stop: () => {
      child.kill('SIGTERM')
    },
  }
}
