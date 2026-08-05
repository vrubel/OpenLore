import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
    },
  },
  {
    files: ['src/viewer/**/*.jsx', 'src/viewer/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-console': 'off',
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-undef': 'off',
    },
  },
  {
    // src/pi/** is out of scope on this fork line, and eslint must agree with
    // tsconfig, which already excludes it. The typed rules above ask the parser for
    // a `project`, so any file OUTSIDE tsconfig's program is a hard parse error
    // ("file was not found in any of the provided project(s)") rather than a lint
    // finding — `npm run lint` = `eslint src` walked into src/pi and died there.
    // The VS Code extension is not built, not published and not tested here: the
    // slim series dropped @earendil-works/pi-ai from install. The sources stay in
    // tree (they still justify the windows-extension-launcher-shell accepted risk,
    // which is read straight off disk), they are simply not linted.
    ignores: ['dist/**', 'node_modules/**', 'examples/**', '*.config.js', '*.config.ts', 'src/core/scip/fixtures/**', 'src/core/analyzer/iac/fixtures/**', 'src/pi/**'],
  }
);
