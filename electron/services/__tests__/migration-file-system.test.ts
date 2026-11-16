import fs from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { migrationRealpath, validatePlatformDirectoryChain } from '../migration-file-system'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('only falls back from Windows native EPERM and propagates other failures', () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const standard = vi.spyOn(fs, 'realpathSync').mockReturnValue('C:\\verified')
  const native = vi.fn(() => { throw Object.assign(new Error('native permission'), { code: 'EPERM' }) })
  Object.assign(standard, { native })
  expect(migrationRealpath('C:\\verified')).toBe('C:\\verified')
  expect(standard).toHaveBeenCalledTimes(1)
  native.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) })
  expect(() => migrationRealpath('C:\\verified')).toThrow('missing')
  expect(standard).toHaveBeenCalledTimes(1)
  native.mockImplementation(() => { throw Object.assign(new Error('native permission'), { code: 'EPERM' }) })
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  expect(() => migrationRealpath('/private')).toThrow('native permission')
  expect(standard).toHaveBeenCalledTimes(1)
})

it('delegates the complete directory chain to the platform and never swallows its rejection', () => {
  const platformFs = fs as typeof fs & { validateDirectoryChain?: (directory: string, options?: { allowMissing?: boolean }) => void }
  expect(validatePlatformDirectoryChain('/app/private')).toBe(false)
  const validate = vi.fn()
  platformFs.validateDirectoryChain = validate
  try {
    expect(validatePlatformDirectoryChain('/app/private/new', true)).toBe(true)
    expect(validate).toHaveBeenCalledWith('/app/private/new', { allowMissing: true })
    validate.mockImplementation(() => { throw new Error('OUTSIDE_PRIVATE_ROOT') })
    expect(() => validatePlatformDirectoryChain('/data')).toThrow('OUTSIDE_PRIVATE_ROOT')
  } finally { delete platformFs.validateDirectoryChain }
})
