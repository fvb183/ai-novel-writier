import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'
import { createNativeMock } from '../../test/mobile-native-mock.mjs'

// The original tests create temporary projects. Direct those projects into
// the native protocol mock's private filesystem, with no source-test edits.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vela-native-vector-tests-')))
const temporaryVariables = ['TMPDIR', 'TEMP', 'TMP']
const previousTemporaryDirectories = Object.fromEntries(temporaryVariables.map(name => [name, process.env[name]]))
const previousBridge = globalThis.AndroidBridge
const native = createNativeMock(root)
globalThis.AndroidBridge = native
for (const name of temporaryVariables) process.env[name] = native.environment.filesDir

afterAll(() => {
  native.close()
  for (const name of temporaryVariables) {
    if (previousTemporaryDirectories[name] === undefined) delete process.env[name]
    else process.env[name] = previousTemporaryDirectories[name]
  }
  if (previousBridge === undefined) delete globalThis.AndroidBridge
  else globalThis.AndroidBridge = previousBridge
  fs.rmSync(root, { recursive: true, force: true })
})
