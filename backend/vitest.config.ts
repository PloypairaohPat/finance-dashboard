import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    // All specs share one seeded fixture set against one real (test) database —
    // keep everything single-threaded so fixture setup/teardown can't race.
    fileParallelism: false,
  },
})
