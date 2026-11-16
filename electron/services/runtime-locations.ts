import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const RUNTIME_LOCATIONS_FILE = 'runtime-locations.json'
export const RUNTIME_LOCATION_VARIABLES = {
  globalDataHome: 'AI_NOVEL_APP_DATA_HOME',
  userData: 'AI_NOVEL_ELECTRON_USER_DATA_DIR',
  legacySource: 'AI_NOVEL_LEGACY_SOURCE_HOME',
  syncProjectsHome: 'AI_NOVEL_SYNC_PROJECTS_HOME',
} as const
export type RuntimeLocationName = keyof typeof RUNTIME_LOCATION_VARIABLES
export interface RuntimeDirectoryIdentity { device: string; inode: string }
export interface RuntimeDirectoryLocation {
  path: string
  identity?: RuntimeDirectoryIdentity
  /** Only a not-yet-created sync directory may bind its existing parent. */
  parentIdentity?: RuntimeDirectoryIdentity
}
export interface RuntimeLocationsDescriptor {
  format: 'ai-novel-runtime-locations'
  version: 1
  locations: Record<RuntimeLocationName, RuntimeDirectoryLocation>
}
export type RuntimeLocationFailureReason = 'descriptor-invalid' | 'location-unavailable' | 'unsafe-path' | 'overlap'
type Environment = Record<string, string | undefined>
type EnvironmentPatch = Partial<Record<typeof RUNTIME_LOCATION_VARIABLES[RuntimeLocationName], string>>
const names = Object.keys(RUNTIME_LOCATION_VARIABLES) as RuntimeLocationName[]

function fail(reason: RuntimeLocationFailureReason): never {
  throw Object.assign(new Error('GLOBAL_DATA_BLOCKED'), { runtimeLocationReason: reason })
}
export function runtimeLocationFailureReason(error: unknown): RuntimeLocationFailureReason {
  const reason = (error as { runtimeLocationReason?: unknown } | null)?.runtimeLocationReason
  return ['descriptor-invalid', 'location-unavailable', 'unsafe-path', 'overlap'].includes(String(reason)) ? reason as RuntimeLocationFailureReason : 'descriptor-invalid'
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('descriptor-invalid')
  return value as Record<string, unknown>
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('descriptor-invalid')
}
function localDirectoryPath(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 240 || /[\x00-\x1f<>"|?*]/.test(value)
    || !/^[A-Za-z]:[\\/]/.test(value) || value.slice(2).includes(':') || value.split(/[\\/]/).some(part => part === '.' || part === '..')) fail('unsafe-path')
  if (value.slice(3).split(/[\\/]/).some(part => /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) fail('unsafe-path')
  const normalized = path.win32.normalize(value)
  if (/^[A-Za-z]:\\$/.test(normalized)) fail('unsafe-path')
  return normalized.replace(/\\+$/, '')
}
const key = (value: string) => path.win32.normalize(value).replace(/\\+$/, '').toLowerCase()
const nested = (parent: string, child: string) => key(parent) === key(child) || key(child).startsWith(key(parent) + '\\')
function disjoint(locations: string[], installationRoot?: string) {
  for (let left = 0; left < locations.length; left++) for (let right = left + 1; right < locations.length; right++) {
    if (nested(locations[left], locations[right]) || nested(locations[right], locations[left])) fail('overlap')
  }
  if (installationRoot) for (const location of locations) if (nested(location, installationRoot) || nested(installationRoot, location)) fail('overlap')
}
function identity(value: unknown): RuntimeDirectoryIdentity {
  const entry = record(value); exactKeys(entry, ['device', 'inode'])
  if (typeof entry.device !== 'string' || typeof entry.inode !== 'string' || !/^\d{1,20}$/.test(entry.device) || !/^\d{1,20}$/.test(entry.inode)) fail('descriptor-invalid')
  return { device: entry.device, inode: entry.inode }
}
function sameIdentity(left: RuntimeDirectoryIdentity, right: RuntimeDirectoryIdentity) { return left.device === right.device && left.inode === right.inode }

/** Read-only verification output deliberately omits full paths, directory
 * identities and every configuration value. Hashes permit exact local checks. */
export function summarizeRuntimeLocations(locations: Record<RuntimeLocationName, string>, descriptorApplied: boolean, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  return { format: 'ai-novel-runtime-locations-verification', version: 1, status: 'verified', descriptorApplied,
    locations: Object.fromEntries(names.map(name => {
      const normalized = paths.normalize(locations[name]).replace(/[\\/]+$/, '')
      const drive = paths.parse(normalized).root
      return [name, { drive: platform === 'win32' ? drive.toUpperCase() : drive,
        pathSha256: createHash('sha256').update(platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex') }]
    })) }
}

/** Strict public-path schema: credentials, author files and arbitrary keys are rejected. */
export function parseRuntimeLocations(value: unknown): RuntimeLocationsDescriptor {
  const descriptor = record(value); exactKeys(descriptor, ['format', 'version', 'locations'])
  if (descriptor.format !== 'ai-novel-runtime-locations' || descriptor.version !== 1) fail('descriptor-invalid')
  const input = record(descriptor.locations); exactKeys(input, names)
  const locations = {} as RuntimeLocationsDescriptor['locations']
  for (const name of names) {
    const entry = record(input[name]); exactKeys(entry, ['path'], ['identity', 'parentIdentity'])
    const hasIdentity = Object.hasOwn(entry, 'identity'), hasParent = Object.hasOwn(entry, 'parentIdentity')
    if (hasIdentity === hasParent || hasParent && name !== 'syncProjectsHome') fail('descriptor-invalid')
    locations[name] = { path: localDirectoryPath(entry.path), ...(hasIdentity ? { identity: identity(entry.identity) } : { parentIdentity: identity(entry.parentIdentity) }) }
    if (name === 'syncProjectsHome' && locations[name].path.length + 14 > 85) fail('unsafe-path')
  }
  disjoint(names.map(name => locations[name].path))
  return { format: 'ai-novel-runtime-locations', version: 1, locations }
}

/** Metadata only. No configuration, credential, database or novel bytes are read. */
export function inspectRuntimeDirectory(directory: string): RuntimeDirectoryIdentity {
  try {
    const resolved = path.resolve(directory), before = fs.lstatSync(resolved, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) fail('unsafe-path')
    for (let cursor = resolved;; cursor = path.dirname(cursor)) {
      const stat = fs.lstatSync(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe-path')
      if (cursor === path.dirname(cursor)) break
    }
    if (key(fs.realpathSync.native(resolved)) !== key(resolved)) fail('unsafe-path')
    const after = fs.lstatSync(resolved, { bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino) fail('unsafe-path')
    return { device: after.dev.toString(), inode: after.ino.toString() }
  } catch (error) {
    if ((error as { runtimeLocationReason?: unknown })?.runtimeLocationReason) throw error
    return fail('location-unavailable')
  }
}

export function readPackagedRuntimeLocations(resourcesDirectory: string, platform: string, packaged: boolean, applicationDirectory?: string): RuntimeLocationsDescriptor | undefined {
  if (!packaged || platform !== 'win32') return undefined
  let expectedHash: string | undefined
  if (applicationDirectory) {
    let metadata: Record<string, unknown>
    try { metadata = record(JSON.parse(fs.readFileSync(path.join(applicationDirectory, 'package.json'), 'utf8'))) }
    catch { return fail('descriptor-invalid') }
    if (metadata.aiNovelRuntimeLocations !== undefined) {
      const marker = record(metadata.aiNovelRuntimeLocations); exactKeys(marker, ['version', 'required', 'sha256'])
      if (marker.version !== 1 || marker.required !== true || typeof marker.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(marker.sha256)) fail('descriptor-invalid')
      expectedHash = marker.sha256
    }
  }
  const file = path.join(resourcesDirectory, RUNTIME_LOCATIONS_FILE)
  let stat: fs.Stats
  try { stat = fs.lstatSync(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !expectedHash) return undefined
    return fail('location-unavailable')
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024) fail('unsafe-path')
  try {
    const bytes = fs.readFileSync(file)
    if (expectedHash && createHash('sha256').update(bytes).digest('hex') !== expectedHash) fail('descriptor-invalid')
    return parseRuntimeLocations(JSON.parse(bytes.toString('utf8')))
  }
  catch (error) { if ((error as { runtimeLocationReason?: unknown })?.runtimeLocationReason) throw error; return fail('descriptor-invalid') }
}

/** Complete explicit startup context is also the recovery/test escape hatch:
 * it never probes a personal package's source directories. */
export function resolveDesktopRuntimeLocations(options: {
  resourcesDirectory: string
  applicationDirectory: string
  platform: string
  packaged: boolean
  env: Environment
  cliUserData?: string
  installationRoot?: string
}) {
  const has = (variable: string) => Boolean(options.env[variable]?.trim())
  const completeOverrides = has('AI_NOVEL_APP_DATA_HOME') && (Boolean(options.cliUserData?.trim()) || has('AI_NOVEL_ELECTRON_USER_DATA_DIR'))
    && (has('AI_NOVEL_LEGACY_SOURCE_HOME') || has('AI_NOVEL_VELA_HOME')) && has('AI_NOVEL_SYNC_PROJECTS_HOME')
  const descriptor = completeOverrides ? undefined : readPackagedRuntimeLocations(options.resourcesDirectory, options.platform, options.packaged, options.applicationDirectory)
  return resolveRuntimeLocations({ ...options, descriptor })
}

export function resolveRuntimeLocations(options: {
  descriptor?: unknown
  env: Environment
  cliUserData?: string
  installationRoot?: string
  inspectDirectory?: (directory: string) => RuntimeDirectoryIdentity
}): { userData?: string; environment: EnvironmentPatch; descriptorApplied: boolean } {
  const explicit = (name: RuntimeLocationName) => (name === 'userData' ? options.cliUserData?.trim() : undefined)
    || options.env[RUNTIME_LOCATION_VARIABLES[name]]?.trim()
    || (name === 'legacySource' ? options.env.AI_NOVEL_VELA_HOME?.trim() : undefined)
  const explicitUserData = explicit('userData')
  if (explicitUserData && !path.isAbsolute(explicitUserData)) fail('unsafe-path')
  if (options.descriptor === undefined) return { userData: explicitUserData, environment: {}, descriptorApplied: false }
  const descriptor = parseRuntimeLocations(options.descriptor), environment: EnvironmentPatch = {}, effective: string[] = []
  const inspect = options.inspectDirectory ?? inspectRuntimeDirectory
  let descriptorApplied = false
  for (const name of names) {
    const override = explicit(name), entry = descriptor.locations[name]
    if (override) { effective.push(localDirectoryPath(override)); continue }
    descriptorApplied = true
    const directory = entry.identity ? entry.path : path.win32.dirname(entry.path)
    if (!sameIdentity(inspect(directory), (entry.identity ?? entry.parentIdentity)!)) fail('unsafe-path')
    if (entry.parentIdentity) {
      try { fs.lstatSync(entry.path); inspect(entry.path) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    environment[RUNTIME_LOCATION_VARIABLES[name]] = entry.path; effective.push(entry.path)
  }
  if (descriptorApplied) disjoint(effective, options.installationRoot)
  return { userData: explicitUserData ?? environment.AI_NOVEL_ELECTRON_USER_DATA_DIR, environment, descriptorApplied }
}

/** Explicit installer preparation; all directory bindings are metadata only. */
export function createRuntimeLocations(paths: Record<RuntimeLocationName, string>): RuntimeLocationsDescriptor {
  const locations = {} as RuntimeLocationsDescriptor['locations']
  for (const name of names) {
    const directory = localDirectoryPath(path.resolve(paths[name]))
    let missing = false
    try { fs.lstatSync(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('location-unavailable')
      missing = true
    }
    if (name === 'syncProjectsHome' && missing) locations[name] = { path: directory, parentIdentity: inspectRuntimeDirectory(path.dirname(directory)) }
    else locations[name] = { path: directory, identity: inspectRuntimeDirectory(directory) }
  }
  // An accidental arbitrary folder cannot become a global configuration destination.
  const receipt = path.join(locations.globalDataHome.path, '.migration', 'receipt.json')
  try { inspectRuntimeDirectory(path.dirname(receipt)); const stat = fs.lstatSync(receipt); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('unsafe-path') }
  catch (error) { if ((error as { runtimeLocationReason?: unknown })?.runtimeLocationReason) throw error; return fail('location-unavailable') }
  return parseRuntimeLocations({ format: 'ai-novel-runtime-locations', version: 1, locations })
}
