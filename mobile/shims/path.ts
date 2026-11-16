// POSIX is Android's native path format. Windows paths are needed only to validate
// imported desktop project metadata and root-relative secure-file capabilities.
import posixPath from 'path-browserify'
export const posix = posixPath
function check(value: string) { if (typeof value !== 'string') throw new TypeError('Path must be a string'); return value }
function winRoot(path: string): string {
  const p = check(path).replace(/\//g, '\\')
  if (/^\\\\[^\\]+\\[^\\]+/.test(p)) return p.match(/^\\\\[^\\]+\\[^\\]+\\?/)![0].replace(/\\?$/, '\\')
  if (/^[A-Za-z]:\\/.test(p)) return p.slice(0, 3)
  if (/^[A-Za-z]:/.test(p)) return p.slice(0, 2)
  return p.startsWith('\\') ? '\\' : ''
}
function winNormalize(path: string): string {
  const p = check(path).replace(/\//g, '\\'); if (!p) return '.'
  const root = winRoot(p); const absolute = root.endsWith('\\'); const parts: string[] = []
  for (const part of p.slice(root.length).split('\\')) {
    if (!part || part === '.') continue
    if (part === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!absolute) parts.push(part) }
    else parts.push(part)
  }
  let result = root + parts.join('\\')
  if (!result) result = '.'
  if (p.endsWith('\\') && !result.endsWith('\\')) result += '\\'
  return result
}
function winIsAbsolute(path: string): boolean { return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(check(path)) }
function winJoin(...paths: string[]): string { return winNormalize(paths.map(check).filter(Boolean).join('\\')) }
function winDirname(path: string): string {
  const p = check(path)
  const unc = p.match(/^[\\/]{2}[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$)/)
  const device = p.match(/^[A-Za-z]:(?:[\\/]|$)?/)
  const rootLength = unc ? unc[0].length : device ? device[0].length : /^[\\/]/.test(p) ? 1 : 0
  let end = p.length
  while (end > rootLength && /[\\/]/.test(p[end - 1])) end--
  for (let index = end - 1; index >= rootLength; index--) if (/[\\/]/.test(p[index])) return p.slice(0, index)
  return rootLength ? p.slice(0, rootLength) : '.'
}
function winBasename(path: string, suffix?: string): string {
  return posixPath.basename(check(path).replace(/^[A-Za-z]:/, '').replace(/\\/g, '/'), suffix)
}
function winExtname(path: string): string { return posixPath.extname(winBasename(path)) }
function winResolve(...paths: string[]): string {
  let merged = ''
  for (let i = paths.length - 1; i >= 0; i--) {
    const next = check(paths[i]); if (!next) continue
    merged = next + (merged ? '\\' + merged : '')
    if (winIsAbsolute(next)) return winNormalize(merged)
  }
  return winNormalize('\\' + merged)
}
function winRelative(from: string, to: string): string {
  const a = winResolve(from), b = winResolve(to)
  if (winRoot(a).toLowerCase() !== winRoot(b).toLowerCase()) return b
  const aa = a.split('\\').filter(Boolean), bb = b.split('\\').filter(Boolean)
  let count = 0; while (count < aa.length && count < bb.length && aa[count].toLowerCase() === bb[count].toLowerCase()) count++
  return [...aa.slice(count).map(() => '..'), ...bb.slice(count)].join('\\')
}
function winParse(path: string) { const base = winBasename(path), ext = winExtname(path); return { root: winRoot(path), dir: winDirname(path) === '.' ? '' : winDirname(path), base, ext, name: base.slice(0, base.length - ext.length) } }
export const win32: any = { normalize: winNormalize, join: winJoin, dirname: winDirname, basename: winBasename, extname: winExtname, resolve: winResolve, relative: winRelative, isAbsolute: winIsAbsolute, parse: winParse, format: (value: any) => value.dir || value.root ? winJoin(value.dir || value.root, value.base || (value.name || '') + (value.ext || '')) : value.base || (value.name || '') + (value.ext || ''), sep: '\\', delimiter: ';' }
win32.win32 = win32; win32.posix = posix
export const { normalize, join, dirname, basename, extname, resolve, relative, isAbsolute, parse, format, sep, delimiter } = posixPath
export function toNamespacedPath(path: string) { return path }
export default { ...posixPath, posix, win32, toNamespacedPath }
