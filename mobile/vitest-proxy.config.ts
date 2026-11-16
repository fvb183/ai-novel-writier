import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { environment: 'node', include: ['mobile/tests/proxy-network.test.ts'] } })
