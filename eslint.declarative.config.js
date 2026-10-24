import tseslint from 'typescript-eslint';

import baseConfig from './eslint.config.js';

// Advisory declarative-style rules, run on their own by `npm run lint:declarative`.
// Every rule is a warning. This config is deliberately NOT part of `npm run lint`:
// that gate fails on any warning (--max-warnings=0), and these rules report on
// existing code. Same scope as the main lint: its global ignores, its file types.
const { ignores } = baseConfig.find((entry) => entry.ignores && Object.keys(entry).length === 1);

export default tseslint.config(
  { ignores },
  // Inline disables in the tree target the main config's rules, so here they
  // would read as unused; the main lint already fails on genuinely stale ones.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: { parser: tseslint.parser },
    // Registered (no rules enabled) so inline `@typescript-eslint/*` disables resolve.
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          selector: 'ForStatement',
          message:
            '[ForStatement] Prefer declarative iteration: map/filter/reduce/flatMap/some/every/find/Object.entries/Array.from instead of a for loop.',
        },
        {
          selector: 'ForInStatement',
          message:
            '[ForInStatement] Prefer Object.keys/Object.entries with map/filter/reduce/flatMap/some/every/find/Array.from instead of for...in.',
        },
        {
          selector: 'ForOfStatement[await=false]',
          message:
            '[ForOfStatement] Prefer map/filter/reduce/flatMap/some/every/find/Object.entries/Array.from instead of for...of.',
        },
        {
          selector: 'WhileStatement',
          message:
            '[WhileStatement] Prefer declarative iteration (map/filter/reduce/flatMap/some/every/find/Object.entries/Array.from) instead of while.',
        },
        {
          selector: 'DoWhileStatement',
          message:
            '[DoWhileStatement] Prefer declarative iteration (map/filter/reduce/flatMap/some/every/find/Object.entries/Array.from) instead of do...while.',
        },
      ],
      'no-param-reassign': ['warn', { props: true }],
      'no-var': 'warn',
      'no-plusplus': 'warn',
      'prefer-const': 'warn',
      'prefer-arrow-callback': 'warn',
      'array-callback-return': 'warn',
    },
  },
);
