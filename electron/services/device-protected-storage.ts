/** Electron's backend-name API is Linux-only; Windows/macOS/Android use their device store. */
export function deviceProtectedStorageAvailable(storage: { isEncryptionAvailable(): boolean; getSelectedStorageBackend?(): string }, platform: string = process.platform): boolean {
  try {
    if (!storage.isEncryptionAvailable()) return false
    if (platform !== 'linux') return true
    return ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(storage.getSelectedStorageBackend?.() ?? '')
  } catch { return false }
}
