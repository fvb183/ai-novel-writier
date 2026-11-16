/** Prepare an explicit personal installer overlay. No credentials or novels are
 * read, copied, or put in the package. Run Node >=22 with --experimental-strip-types. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRuntimeLocations, RUNTIME_LOCATIONS_FILE } from '../electron/services/runtime-locations.ts'

const root = path.resolve(import.meta.dirname, '..')
const allowed = new Set(['app-data-home', 'user-data', 'legacy-source', 'sync-projects-home', 'output'])
const args = new Map()
for (const argument of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.+)$/.exec(argument)
  if (!match || !allowed.has(match[1]) || args.has(match[1])) throw new Error('Expected each named path once: --app-data-home=... --user-data=... --legacy-source=... --sync-projects-home=... --output=.runtime/<new-directory>')
  args.set(match[1], match[2])
}
for (const required of ['app-data-home', 'user-data', 'legacy-source', 'sync-projects-home']) if (!args.has(required)) throw new Error(`Missing explicit --${required}`)
const descriptor = createRuntimeLocations({ globalDataHome: args.get('app-data-home'), userData: args.get('user-data'),
  legacySource: args.get('legacy-source'), syncProjectsHome: args.get('sync-projects-home') })
const output = path.resolve(root, args.get('output') ?? '.runtime/windows-install-profile')
const runtime = fs.realpathSync.native(path.join(root, '.runtime'))
if (path.dirname(output).toLowerCase() !== runtime.toLowerCase() || !/^windows-[A-Za-z0-9_-]+$/.test(path.basename(output))) throw new Error('Profile output must be a new immediate .runtime/windows-* directory')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
fs.mkdirSync(output) // Exclusive: never replace an earlier reviewable descriptor.
const descriptorPath = path.join(output, RUNTIME_LOCATIONS_FILE), bytes = JSON.stringify(descriptor, null, 2) + '\n'
fs.writeFileSync(descriptorPath, bytes, { flag: 'wx' })
const sha256 = createHash('sha256').update(bytes).digest('hex')
const configuration = { extends: path.join(root, 'electron-builder.json5'),
  extraMetadata: { aiNovelRuntimeLocations: { version: 1, required: true, sha256 } },
  extraResources: [{ from: descriptorPath, to: RUNTIME_LOCATIONS_FILE }],
  directories: { output: path.join(root, 'release', `${version}-sync-fix`) },
  nsis: { runAfterFinish: false } }
const configPath = path.join(output, 'electron-builder.json')
fs.writeFileSync(configPath, JSON.stringify(configuration, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ descriptor: descriptorPath, config: configPath, descriptorSha256: sha256, version,
  containsCredentials: false, containsAuthorFiles: false, standardBuildConfigurationUnchanged: true }))
