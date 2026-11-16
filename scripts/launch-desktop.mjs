import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureElectronNativeBinding } from './prepare-native-for-electron.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
for (const relative of ['dist-electron/main.js', 'dist/index.html']) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`Missing ${relative}. Run pnpm run build first.`)
}
process.env.npm_config_cache ??= path.join(root, '.runtime', 'npm-cache')
process.env.ELECTRON_CACHE ??= path.join(root, '.runtime', 'electron-cache')
await ensureElectronNativeBinding()
if (process.argv.includes('--check')) {
  console.log('Desktop build and Electron SQLite binding are ready.')
} else {
  const profile = path.join(root, '.runtime', 'desktop-profile')
  const env = { ...process.env }
  // Development configuration is separate from the installed application.
  if (!env.AI_NOVEL_APP_DATA_HOME?.trim()) env.AI_NOVEL_APP_DATA_HOME = path.join(profile, 'app-data')
  if (!env.AI_NOVEL_LEGACY_SOURCE_HOME?.trim()) env.AI_NOVEL_LEGACY_SOURCE_HOME = path.join(profile, 'legacy-empty')
  delete env.ELECTRON_RUN_AS_NODE
  delete env.VITE_DEV_SERVER_URL
  fs.mkdirSync(path.join(profile, 'legacy-empty'), { recursive: true })
  const child = spawn(require('electron'), [root, `--user-data-dir=${path.join(profile, 'electron-user')}`], {
    // windowsHide also hides the first GUI window on Windows, even when Electron
    // creates its BrowserWindow with show:true. Only console probes should hide.
    cwd: root, env, stdio: 'inherit', windowsHide: false,
  })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
}
