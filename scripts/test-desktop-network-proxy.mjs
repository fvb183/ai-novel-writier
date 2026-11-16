import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = path.join(root, '.runtime', 'desktop-proxy-probe')
fs.mkdirSync(work, { recursive: true })
fs.mkdirSync(path.join(work, 'profile'), { recursive: true })
const openssl = [process.env.OPENSSL_BINARY, 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'openssl'].filter(Boolean)
let certificateCreated = false
for (const binary of openssl) {
  const generated = spawnSync(binary, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(work, 'synthetic-key.pem'),
    '-out', path.join(work, 'synthetic-cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
  { stdio: 'ignore', windowsHide: true })
  if (generated.status === 0) { certificateCreated = true; break }
}
if (!certificateCreated) throw new Error('SYNTHETIC_CERTIFICATE_GENERATOR_UNAVAILABLE')
const bundled = await build({ absWorkingDir: root, entryPoints: ['electron/services/__tests__/desktop-network-loopback.probe.ts'],
  outfile: path.join(work, 'entry.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], metafile: true, logLevel: 'silent' })
const inputs = Object.keys(bundled.metafile.inputs).filter(file => !file.startsWith('node_modules/'))
fs.writeFileSync(path.join(work, 'source-manifest.json'), JSON.stringify(inputs.map(file => ({ file,
  sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') })), null, 2) + '\n')
fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'synthetic-desktop-proxy-probe', version: '1.0.0', main: 'entry.cjs' }) + '\n')
const env = { ...process.env }
for (const key of Object.keys(env)) if (/^(?:https?_proxy|all_proxy|no_proxy|node_options|node_use_env_proxy|electron_run_as_node|ai_novel_.*home)$/i.test(key)) delete env[key]
env.AI_NOVEL_APP_DATA_HOME = path.join(work, 'app-data')
env.AI_NOVEL_VELA_HOME = path.join(work, 'legacy')
const electron = createRequire(import.meta.url)('electron')
const result = await new Promise((resolve, reject) => {
  const child = spawn(electron, ['--disable-gpu-sandbox', '--disable-gpu', '--user-data-dir=' + path.join(work, 'profile'), work],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderrPresent = false
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', () => { stderrPresent = true })
  const timeout = setTimeout(() => { child.kill(); reject(new Error('ISOLATED_ELECTRON_PROXY_PROBE_TIMEOUT')) }, 60000)
  child.on('error', error => { clearTimeout(timeout); reject(error) })
  child.on('exit', code => { clearTimeout(timeout); resolve({ code, stdout: stdout.trim(), stderrPresent }) })
})
console.log(JSON.stringify(result))
if (result.code !== 0) process.exitCode = 1
