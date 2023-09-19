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
      statements: 100,
      branches: 85,
      functions: 100,
      lines: 100,
    },
  },
})
