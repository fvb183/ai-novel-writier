import fs from 'node:fs'
import path from 'node:path'
import { afterAll } from 'vitest'

// Use a canonical fixture root: Windows TEMP may contain an 8.3 alias that the
// production archive checks correctly reject as a different textual path.
const root = fs.mkdtempSync(path.join(process.cwd(), '.mobile-archive-test-'))
const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
for (const key of Object.keys(previous)) process.env[key] = fs.realpathSync.native(root)
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value
  fs.rmSync(root, { recursive: true, force: true })
})
