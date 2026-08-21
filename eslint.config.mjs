import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['eslint.config.mjs', '**/dist/**', '**/node_modules/**', '**/coverage/**', 'apps/web/static/**', 'spikes/**', '.lazyweb/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: './tsconfig.lint.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error',
        ...['a', 'button', 'details', 'fieldset', 'input', 'label', 'legend', 'optgroup', 'option', 'select', 'summary', 'textarea'].map((name) => ({ selector: `JSXOpeningElement[name.name='${name}']`, message: `Use the matching HeroUI component instead of <${name}>.` })),
      ],
    },
  },
);
