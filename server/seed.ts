import { cp, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Seed a persistent data directory on first boot.
 *
 * On a hosted deploy the data directory is a mounted volume, which starts
 * empty. The image ships the imported workbook data, so an empty volume is
 * filled from it once; after that the volume is the source of truth and is
 * never overwritten, or a redeploy would discard the analyst's edits.
 */
export async function seedDataDir(dataDir: string, bundled: string): Promise<'seeded' | 'existing' | 'skipped'> {
  if (path.resolve(dataDir) === path.resolve(bundled)) return 'skipped'
  if (!existsSync(bundled)) return 'skipped'

  await mkdir(dataDir, { recursive: true })
  const existing = await readdir(dataDir)
  if (existing.some((entry) => entry.endsWith('.json'))) return 'existing'

  await cp(bundled, dataDir, { recursive: true })
  return 'seeded'
}
