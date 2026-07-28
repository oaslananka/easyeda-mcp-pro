import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const dynamicExecutionRule = {
  selector: "NewExpression[callee.name='AsyncFunction']",
  message:
    'Dynamic execution requires a local, justified eslint exception and a safety regression test.',
};

const automationSafetyRules = {
  'no-restricted-imports': [
    'error',
    {
      paths: [
        {
          name: 'child_process',
          importNames: ['exec', 'execSync'],
          message: 'Use execFile/spawn with an argument array instead of a shell command string.',
        },
        {
          name: 'node:child_process',
          importNames: ['exec', 'execSync'],
          message: 'Use execFile/spawn with an argument array instead of a shell command string.',
        },
      ],
    },
  ],
  'no-restricted-syntax': ['error', dynamicExecutionRule],
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-path-concat': 'error',
};

const typedAsyncSafetyRules = {
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/no-floating-promises': ['error', { ignoreIIFE: true, ignoreVoid: true }],
  '@typescript-eslint/no-misused-promises': [
    'error',
    { checksVoidReturn: { arguments: false, attributes: false } },
  ],
  '@typescript-eslint/only-throw-error': 'error',
  '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
};

const javascriptAutomationFiles = [
  'eslint.config.js',
  'scripts/**/*.js',
  'scripts/**/*.mjs',
  'scripts/**/*.cjs',
  'easyeda-bridge-extension/scripts/**/*.mjs',
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'TEMP/**',
      'docs/.vitepress/dist/**',
      'docs/.vitepress/cache/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['scripts/**/*.ts', 'scripts/**/*.mts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      ...automationSafetyRules,
      ...typedAsyncSafetyRules,
    },
  },
  {
    files: ['scripts/generate-tools-doc.ts', 'scripts/live-schematic-transaction-smoke.mts'],
    rules: {
      // These scripts normalize intentionally untyped external/runtime payloads.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['easyeda-bridge-extension/src/**/*.ts', 'easyeda-bridge-extension/tests/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./easyeda-bridge-extension/tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
        ...globals.node,
      },
    },
    rules: {
      ...automationSafetyRules,
      ...typedAsyncSafetyRules,
      // EasyEDA's runtime API is discovered dynamically and is not fully typed upstream.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['easyeda-bridge-extension/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-this-alias': 'off',
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: javascriptAutomationFiles,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      ...automationSafetyRules,
    },
  },
  {
    files: ['scripts/maintainer/openssf-badgeapp-autofill.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
);
