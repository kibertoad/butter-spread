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
      statements: 95,
      branches: 80,
      functions: 100,
      lines: 95,
    },
  },
})
