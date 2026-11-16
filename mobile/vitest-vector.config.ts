import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@lancedb/lancedb': path.resolve('mobile/shims/lancedb.ts'),
      electron: path.resolve('mobile/shims/electron.ts'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['mobile/tests/native-vector-setup.mjs'],
    include: [
      'mobile/tests/canonical-runtime.test.ts',
    ],
    testTimeout: 30_000,
  },
})
