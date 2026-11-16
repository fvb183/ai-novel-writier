import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: { alias: { yauzl: path.resolve('mobile/shims/yauzl.ts'), electron: path.resolve('mobile/shims/electron.ts') } },
  test: { environment: 'node', setupFiles: ['mobile/tests/archive-test-setup.ts'], include: ['electron/services/__tests__/portable-project-archive.test.ts'] },
})
