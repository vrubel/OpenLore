import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'examples/**/*.test.ts'],
    // src/pi/** — the VS Code extension — is out of scope on this fork line, the
    // same way tsconfig and eslint exclude it. Its runtime dependency
    // (@earendil-works/pi-ai) was dropped from install by the slim series, so
    // src/pi/extension.test.ts could only ever fail on "Cannot find package" — a
    // dependency we removed on purpose, not a defect the test could catch. The
    // sources stay in tree; they are simply not built, linted or tested here.
    exclude: ['**/*.integration.test.ts', 'node_modules/**', 'src/pi/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '*.config.*',
        // Infrastructure with no testable business logic
        'src/utils/logger.ts',   // log sink, no branching logic
        'src/utils/shutdown.ts', // signal handlers
        'src/utils/prompts.ts',  // @inquirer/prompts UI wiring
        // CLI entry points (integration-tested only)
        'src/cli/**',
        // Viewer React code (frontend, separate test stack)
        'src/viewer/**',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
  resolve: {
    alias: {
      '@': './src',
    },
  },
});
