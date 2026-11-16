import { vi } from 'vitest'
// Keep real host metadata/fixtures while routing the Android secure capability
// operations through the same fs.nativeCall protocol used by the release bundle.
vi.mock('node:fs', async importOriginal => {
  const host = await importOriginal<typeof import('node:fs')>()
  const { nativeCall } = await import('../shims/fs')
  return { ...host, nativeCall, default: { ...host, nativeCall } }
})
