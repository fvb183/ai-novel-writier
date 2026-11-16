import { nativeCall } from './fs'
let environment: any
function env() { return environment ||= nativeCall('env') }
export function homedir(): string { return env().filesDir }
export function tmpdir(): string { return env().cacheDir }
export function platform() { return 'android' }
export function type() { return 'Linux' }
export function release() { return String(env().version || '') }
export function arch() { return 'arm64' }
export const EOL = '\n'
export function cpus() { return [] }
export default { homedir, tmpdir, platform, type, release, arch, EOL, cpus }
