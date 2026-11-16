import fs from 'node:fs'

type PrivateInstallFileSystem = typeof fs & { installExclusiveSync?: (source: string, target: string) => void }

/** Publish a complete owned file without replacing an existing target.
 * Android cannot create hard links under its application SELinux policy. Its
 * native adapter instead moves the file under the private-storage ownership
 * lock and monitor; desktop keeps the hard-link protocol and later cleanup. */
export function installProjectFileExclusive(source: string, target: string): void {
  const install = (fs as PrivateInstallFileSystem).installExclusiveSync
  if (install) install(source, target)
  else fs.linkSync(source, target)
}
