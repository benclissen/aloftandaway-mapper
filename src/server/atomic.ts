import { randomBytes } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

/**
 * Writes `text` to a temporary file in the same folder as `file`, flushes it to disk, then renames it over `file`, so
 * a reader never sees half a file. If any step fails, the temporary file is removed, `file` is left as it was and
 * the error is rethrown.
 */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, file)
  } catch (e) {
    await unlink(tmp).catch(() => undefined)
    throw e
  }
}
