#!/usr/bin/env node
/** Keep each Android alias/native setup in its own Vitest process. */
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs')
const suites = ['file-adapters', 'paths', 'vector', 'stream', 'native-host', 'sync-knowledge', 'verified-open', 'proxy', 'drive-transport']
const results = []
for (const suite of suites) {
  const config = `mobile/vitest-${suite}.config.ts`
  console.log(`\n[android-unit] ${config}`)
  const result = spawnSync(process.execPath, [vitest, 'run', '--config', config], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) console.error(result.error.message)
  results.push({ suite, passed: result.status === 0 && !result.error })
}
console.log('\n[android-unit]', results.map(({ suite, passed }) => `${suite}: ${passed ? 'PASS' : 'FAIL'}`).join(', '))
if (results.some(result => !result.passed)) process.exitCode = 1
