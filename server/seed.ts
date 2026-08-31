import { cp, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Seed a persistent data directory.
 *
 * On a hosted deploy the data directory is a mounted volume, which starts
 * empty. The image ships the imported workbook data, so an empty volume is
 * filled from it once; after that the volume is the source of truth and its
 * files are never overwritten, or a redeploy would discard the analyst's
 * edits.
 *
 * A volume seeded by an older image can still be missing files the current
 * image ships (kpis.json and year-end-closes.json both post-date the first
 * deploys), so every boot also backfills bundled files the volume does not
 * have — add-only, existing files always win.
 */
export async function seedDataDir(
  dataDir: string,
  bundled: string,
): Promise<'seeded' | 'skipped' | { backfilled: string[] }> {
  if (path.resolve(dataDir) === path.resolve(bundled)) return 'skipped'
  if (!existsSync(bundled)) return 'skipped'

  await mkdir(dataDir, { recursive: true })
  const existing = await readdir(dataDir)
  if (!existing.some((entry) => entry.endsWith('.json'))) {
    await cp(bundled, dataDir, { recursive: true })
    return 'seeded'
  }

  const backfilled: string[] = []
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(bundled, relative), { withFileTypes: true })
    for (const entry of entries) {
      const rel = path.join(relative, entry.name)
      const target = path.join(dataDir, rel)
      if (entry.isDirectory()) {
        if (!existsSync(target)) {
          await cp(path.join(bundled, rel), target, { recursive: true })
          backfilled.push(`${rel}${path.sep}`)
        } else {
          await walk(rel)
        }
      } else if (!existsSync(target)) {
        await cp(path.join(bundled, rel), target)
        backfilled.push(rel)
      }
    }
  }
  await walk('')
  return { backfilled }
}
