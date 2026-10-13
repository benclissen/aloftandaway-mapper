import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/e2e/**', '**/node_modules/**'],
          passWithNoTests: true,
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
