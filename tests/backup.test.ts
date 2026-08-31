import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runBackup, scrubSecrets, backupConfigFromEnv } from '../server/backup.js'

/**
 * The backup pushes to a real git remote; a local bare repository stands in
 * for GitHub so the whole flow — first push, no-op, incremental — runs for
 * real without a network.
 */

let root: string
let remote: string
let dataDir: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' })

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'backup-test-'))
  remote = path.join(root, 'remote.git')
  git(root, 'init', '--bare', remote)

  dataDir = path.join(root, 'data')
  mkdirSync(path.join(dataDir, 'models'), { recursive: true })
  writeFileSync(path.join(dataDir, 'overrides.json'), '{"companies":{}}\n')
  writeFileSync(path.join(dataDir, 'models', 'ADBE.json'), '{"ticker":"ADBE"}\n')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('git backup', () => {
  const config = () => ({ remote, branch: 'data-backup' })

  it('pushes the data directory to the branch on first run', async () => {
    expect(await runBackup(dataDir, config())).toBe('pushed')
    const files = git(root, '--git-dir', remote, 'ls-tree', '-r', '--name-only', 'data-backup')
    expect(files).toContain('overrides.json')
    expect(files).toContain('models/ADBE.json')
  })

  it('reports unchanged rather than pushing an empty commit', async () => {
    await runBackup(dataDir, config())
    expect(await runBackup(dataDir, config())).toBe('unchanged')
    const count = git(root, '--git-dir', remote, 'rev-list', '--count', 'data-backup').trim()
    expect(count).toBe('1')
  })

  it('pushes again when the data changes, and propagates deletions', async () => {
    await runBackup(dataDir, config())
    writeFileSync(path.join(dataDir, 'overrides.json'), '{"companies":{"CRM":{}}}\n')
    rmSync(path.join(dataDir, 'models', 'ADBE.json'))
    expect(await runBackup(dataDir, config())).toBe('pushed')

    const files = git(root, '--git-dir', remote, 'ls-tree', '-r', '--name-only', 'data-backup')
    expect(files).not.toContain('models/ADBE.json')
    const body = git(root, '--git-dir', remote, 'show', 'data-backup:overrides.json')
    expect(body).toContain('CRM')
  })
})

describe('configuration and secrecy', () => {
  it('is disabled without a remote', () => {
    expect(backupConfigFromEnv({})).toBeNull()
    expect(backupConfigFromEnv({ BACKUP_GIT_REMOTE: 'https://x@y/z.git' })).toMatchObject({
      branch: 'data-backup',
    })
  })

  it('scrubs the token from anything that could reach a log', () => {
    const url = 'https://x-access-token:ghp_supersecret123@github.com/u/r.git'
    const message = `fatal: unable to access '${url}': 403`
    const scrubbed = scrubSecrets(message, url)
    expect(scrubbed).not.toContain('ghp_supersecret123')
    expect(scrubbed).not.toContain(url)
  })
})
