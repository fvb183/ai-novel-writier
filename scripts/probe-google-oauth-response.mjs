import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..'), directory = path.join(root, '.runtime/google-oauth-electron-probe')
const once = process.argv.includes('--google-once')
const onceOutput = path.join(directory, 'google-invalid-code-once.json'), legacyOutput = path.join(directory, 'result.json')
if (!fs.existsSync(onceOutput) && fs.existsSync(legacyOutput)) {
  const legacy = JSON.parse(fs.readFileSync(legacyOutput, 'utf8'))
  if (legacy.googleInvalidCodeProtocolDiagnostic?.requestCount) fs.copyFileSync(legacyOutput, onceOutput, fs.constants.COPYFILE_EXCL)
}
if (once && fs.existsSync(onceOutput)) throw new Error('GOOGLE_PROTOCOL_DIAGNOSTIC_ALREADY_SENT; read the existing redacted receipt')
const output = once ? onceOutput : path.join(directory, 'local-result.json')
fs.mkdirSync(directory, { recursive: true })
await build({ absWorkingDir: root, entryPoints: ['electron/services/__tests__/google-oauth-electron.probe.ts'], outfile: path.join(directory, 'entry.cjs'),
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'synthetic-google-oauth-probe', version: '1.0.0', main: 'entry.cjs' }))
const env = { ...process.env, AI_NOVEL_OAUTH_PROBE_ROOT: root, AI_NOVEL_OAUTH_PROBE_OUTPUT: output,
  AI_NOVEL_OAUTH_METADATA_APPDATA_ORIGIN: process.env.APPDATA, AI_NOVEL_OAUTH_METADATA_LOCAL_ORIGIN: process.env.LOCALAPPDATA,
  AI_NOVEL_OAUTH_GOOGLE_ONCE: once ? '1' : '0' }
for (const key of Object.keys(env)) if (/^(?:node_options|electron_run_as_node|https?_proxy|all_proxy|no_proxy)$/i.test(key)) delete env[key]
const isolated = path.join(path.dirname(root), '.t', 'google-oauth-probe')
fs.mkdirSync(isolated, { recursive: true })
env.TMP = env.TEMP = path.join(path.dirname(root), '.t')
env.HOME = env.USERPROFILE = isolated; env.APPDATA = path.join(isolated, 'roaming'); env.LOCALAPPDATA = path.join(isolated, 'local')
const executable = createRequire(import.meta.url)('electron')
const result = await new Promise((resolve, reject) => {
  const child = spawn(executable, ['--disable-gpu', '--disable-gpu-sandbox', `--user-data-dir=${path.join(isolated, 'user')}`, directory], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderrPresent = false
  child.stdout.on('data', bytes => { stdout += bytes.toString() }); child.stderr.on('data', () => { stderrPresent = true })
  const timer = setTimeout(() => { child.kill(); reject(new Error('ISOLATED_GOOGLE_PROBE_TIMEOUT')) }, 90000)
  child.on('error', error => { clearTimeout(timer); reject(error) })
  child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderrPresent }) })
})
console.log(JSON.stringify(result))
if (result.code !== 0) process.exitCode = 1
