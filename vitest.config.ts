import { defineConfig } from 'vitest/config'

/**
 * Unit tests never touch the network: tile requests go to an address that refuses connections, and tests that need
 * tiles start a local fake. `MAPPER_NET=1` leaves the real upstream in place.
 */
const offline = process.env.MAPPER_NET ? {} : { MAPPER_TILE_UPSTREAM: 'http://127.0.0.1:9' }

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/e2e/**', '**/node_modules/**'],
          passWithNoTests: true,
          env: offline,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 180000,
          passWithNoTests: true,
        },
      },
    ],
  },
})
