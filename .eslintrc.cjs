/* Root ESLint config — shared across all workspaces */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'prettier',
  ],
  settings: { react: { version: 'detect' } },
  rules: {
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/consistent-type-imports': 'error',
    'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    'eqeqeq': ['error', 'always'],
  },
  ignorePatterns: [
    'node_modules',
    'dist',
    'build',
    'coverage',
    '*.config.js',
    '*.config.cjs',
    '*.config.ts',
    'src-tauri/target',
  ],
  overrides: [
    {
      files: ['**/*.js', '**/*.cjs'],
      rules: { '@typescript-eslint/no-var-requires': 'off' },
    },
    {
      files: ['**/migrations/**/*.js', '**/seeds/**/*.js'],
      env: { node: true, commonjs: true },
      parserOptions: { sourceType: 'script' },
      rules: { '@typescript-eslint/no-var-requires': 'off', 'no-console': 'off' },
    },
    {
      files: ['**/*.cjs', '**/*.config.js'],
      env: { node: true, commonjs: true },
      parserOptions: { sourceType: 'script' },
    },
    {
      files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
      rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
  ],
};
