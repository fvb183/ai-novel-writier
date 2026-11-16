import fs from 'node:fs'

type DirectoryChainFileSystem = typeof fs & {
  validateDirectoryChain?: (directory: string, options?: { allowMissing?: boolean }) => void
}

/** Android validates the complete chain inside its private-root boundary without
 * granting JavaScript read access to /data or other ancestor directories. */
export function validatePlatformDirectoryChain(directory: string, allowMissing = false): boolean {
  const validate = (fs as DirectoryChainFileSystem).validateDirectoryChain
  if (!validate) return false
  validate(directory, { allowMissing })
  return true
}

/** Some Windows profile ancestors reject the native API while the standard
 * implementation can still resolve them. Callers retain their lstat/link and
 * canonical-path comparisons; permission errors on other platforms still fail. */
export function migrationRealpath(file: string): string {
  try { return fs.realpathSync.native(file) }
  catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    return fs.realpathSync(file)
  }
}
