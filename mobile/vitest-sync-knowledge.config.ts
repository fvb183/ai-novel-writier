import { defineConfig } from 'vitest/config'
import path from 'node:path'
export default defineConfig({
  resolve: { alias: [
    { find: '@lancedb/lancedb', replacement: path.resolve('mobile/shims/lancedb.ts') },
    { find: 'electron', replacement: path.resolve('mobile/shims/electron.ts') },
    { find: /^.*\/security\/windows-safe-file-system$/, replacement: path.resolve('mobile/shims/secure-fs.ts') },
  ] },
  test: { environment: 'node', setupFiles: ['mobile/tests/native-sync-knowledge-setup.ts', 'mobile/tests/native-vector-setup.mjs'],
    include: ['electron/services/__tests__/project-sync-knowledge.test.ts'], testTimeout: 60_000 },
})
