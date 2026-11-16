import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: { alias: { yauzl: path.resolve('mobile/shims/yauzl.ts') } },
  test: {
    environment: 'node',
    include: ['electron/services/__tests__/epub-extraction-service.test.ts', 'mobile/tests/file-adapters.test.ts'],
  },
})
