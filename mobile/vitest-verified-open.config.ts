import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['mobile/tests/sqlite-verified-open.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
  },
})
