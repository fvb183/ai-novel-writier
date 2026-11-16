/** Run the installed SQLite ABI under Electron and verify Vitest's fresh report.
 * Windows GUI exe exit/PowerShell completion alone is not a test verdict. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2), selected = args.find(arg => arg.startsWith('--output='))
const output = path.resolve(root, selected?.slice('--output='.length) ?? '.runtime/electron-tests.json')
const relative = path.relative(path.join(root, '.runtime'), output)
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Test report must be inside this checkout .runtime')
fs.mkdirSync(path.dirname(output), { recursive: true })
if (fs.existsSync(output)) fs.renameSync(output, `${output}.${Date.now()}.previous`)
const local = path.join(root, '.runtime', 'test-localapp'), temp = path.resolve(root, '..', '.test-temp')
fs.mkdirSync(local, { recursive: true }); fs.mkdirSync(temp, { recursive: true })
const electron = createRequire(import.meta.url)('electron')
const result = spawnSync(electron, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run',
  ...args.filter(arg => arg !== selected), '--reporter=json', `--outputFile=${output}`], {
  cwd: root, windowsHide: true, stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LOCALAPPDATA: local, TEMP: temp, TMP: temp },
})
let report
try { report = JSON.parse(fs.readFileSync(output, 'utf8')) } catch { /* A missing fresh report is failure. */ }
const passed = result.status === 0 && report?.success === true && report.numPassedTests > 0
  && report.numFailedTests === 0 && report.numFailedTestSuites === 0
console.log(JSON.stringify({ report: output, exitCode: result.status, passed: report?.numPassedTests ?? 0,
  failed: report?.numFailedTests ?? null, success: passed }))
process.exit(passed ? 0 : 1)
