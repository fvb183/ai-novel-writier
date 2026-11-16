import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** Source-only receipt. Excludes novels, credentials, tests and build output. */
export function androidWebSourceFingerprint(root) {
  const entries = []
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const walk = relative => {
    const file = path.join(root, relative), stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error('Android web source must not contain links')
    if (stat.isDirectory()) {
      if (['__tests__', 'tests', 'node_modules', '.runtime', '.git'].includes(path.basename(relative))) return
      for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name))
    } else if (stat.isFile() && !/\.(?:test|browser)\.[cm]?[jt]sx?$/.test(relative)) entries.push([relative.replaceAll('\\', '/'), hash(fs.readFileSync(file))])
  }
  for (const directory of ['src', 'mobile', 'electron', 'public']) walk(directory)
  for (const file of ['package.json', 'vite.android.config.ts', 'scripts/android-web-source-fingerprint.mjs']) walk(file)
  return hash(JSON.stringify(entries))
}
