import { spawn } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Nightly backup of the data directory to a git branch.
 *
 * The analyst's models and overrides live on a single volume; Fly's own
 * snapshots are kept for only a few days. Pushing the plain-JSON data files
 * to a git branch gives durable backups and, as a side effect, restores the
 * audit trail the local setup had: every input change becomes a readable
 * diff with a date.
 *
 * Configuration:
 *   BACKUP_GIT_REMOTE   e.g. https://x-access-token:<token>@github.com/user/repo.git
 *   BACKUP_GIT_BRANCH   branch to push to (default "data-backup")
 *
 * Unset remote = backups disabled, silently. The token rides inside the
 * remote URL, so every error message is scrubbed before it can be logged.
 */

const DEFAULT_BRANCH = 'data-backup'

export interface BackupConfig {
  remote: string
  branch: string
}

export function backupConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BackupConfig | null {
  const remote = env.BACKUP_GIT_REMOTE
  if (!remote) return null
  return { remote, branch: env.BACKUP_GIT_BRANCH || DEFAULT_BRANCH }
}

/** Strip credentials from anything that might reach a log line. */
export function scrubSecrets(text: string, remote: string): string {
  let out = text
  try {
    const url = new URL(remote)
    if (url.password) out = out.split(url.password).join('***')
    if (url.username && url.username !== 'x-access-token') {
      out = out.split(url.username).join('***')
    }
  } catch {
    // A non-URL remote (ssh form) carries no inline token to scrub.
  }
  return out.split(remote).join('<backup-remote>')
}

function run(cmd: string, args: string[], cwd: string, remote: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'valuation-dashboard',
        GIT_AUTHOR_EMAIL: 'backup@valuation-dashboard',
        GIT_COMMITTER_NAME: 'valuation-dashboard',
        GIT_COMMITTER_EMAIL: 'backup@valuation-dashboard',
      },
    })
    let out = ''
    child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { out += d.toString() })
    child.on('error', (e) => reject(new Error(scrubSecrets(String(e), remote))))
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(scrubSecrets(`git ${args[0]} failed (${code}): ${out}`, remote)))
    })
  })
}

/**
 * Push the current data directory to the backup branch.
 *
 * Works in a throwaway clone so the live data directory is never a git
 * checkout: fetch the branch if it exists, replace its contents with the
 * data files, commit if anything changed, push. Returns what happened.
 */
export async function runBackup(
  dataDir: string,
  config: BackupConfig,
): Promise<'pushed' | 'unchanged'> {
  const work = await mkdtemp(path.join(tmpdir(), 'valuation-backup-'))
  const git = (...args: string[]) => run('git', args, work, config.remote)

  try {
    await git('init', '--initial-branch', config.branch, '.')
    await git('remote', 'add', 'origin', config.remote)
    try {
      await git('fetch', '--depth', '1', 'origin', config.branch)
      await git('checkout', '-B', config.branch, `origin/${config.branch}`)
      // Clear the tracked tree so deletions in the data dir propagate.
      await git('rm', '-rq', '--ignore-unmatch', '.')
    } catch {
      // First backup: the branch does not exist yet.
    }

    await cp(dataDir, work, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}.git`),
    })
    await git('add', '-A')

    const status = await git('status', '--porcelain')
    if (!status.trim()) return 'unchanged'

    await git('commit', '-m', `Data backup ${new Date().toISOString()}`)
    await git('push', 'origin', config.branch)
    return 'pushed'
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
