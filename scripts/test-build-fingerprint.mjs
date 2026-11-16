/** Read-only binding of isolated acceptance evidence to the current builds. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export function readBuildFingerprint(root) {
  const fileHash = relative => {
    const file = path.join(root, relative)
    return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null
  }
  const bundleHash = relative => {
    const directory = path.join(root, relative)
    if (!fs.existsSync(directory)) return null
    const visit = (folder, prefix = '') => fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
      const name = prefix + entry.name, file = path.join(folder, entry.name)
      return entry.isDirectory() ? visit(file, `${name}/`) : [[name, sha256(fs.readFileSync(file))]]
    })
    const files = visit(directory).sort(([left], [right]) => left.localeCompare(right))
    return { sha256: sha256(JSON.stringify(files)), files: files.length }
  }
  return { repository: root, main: fileHash('dist-electron/main.js'), renderer: fileHash('dist/index.html'),
    mobileIndex: fileHash('mobile-dist/index.html'), desktopBundle: bundleHash('dist'), mobileBundle: bundleHash('mobile-dist') }
}
