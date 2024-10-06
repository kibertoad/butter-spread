import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    watch: false,
    environment: 'node',
    reporters: ['verbose'],
    coverage: {
      include: ['src/*.ts'],
      reporter: ['text', 'lcov', 'html'],
      all: true,
      thresholds: {
        statements: 100,
        branches: 90,
        functions: 100,
        lines: 100,
      }
    },
  },
})
