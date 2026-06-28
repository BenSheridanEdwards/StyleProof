import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.claude/**', // agent worktrees nest a second checkout (own tsconfig) here — parsing it breaks lint

      '**/__stylemaps__/**',
      '.styleproof/**',
      'test-results/**',
      'playwright-report/**',
      'docs/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  // TypeScript sources: the library and any .ts specs. Browser + node globals
  // because src/capture.ts ships functions that run in the page via
  // page.evaluate (document, window, getComputedStyle…).
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      'no-console': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Node scripts: the CLIs, the test files, and config files. console is the
  // interface here.
  {
    files: ['bin/**/*.mjs', 'test/**/*.mjs', 'bench/**/*.mjs', 'scripts/**/*.mjs', '*.js', '*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
);
