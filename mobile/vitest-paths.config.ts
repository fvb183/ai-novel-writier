import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/shared/__tests__/project-session-context.test.ts',
      'electron/utils/__tests__/project-context.test.ts',
    ],
  },
})
