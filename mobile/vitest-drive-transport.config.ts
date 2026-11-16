import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['mobile/tests/google-drive-transport.test.ts', 'mobile/tests/proxy-network.test.ts'] } })
