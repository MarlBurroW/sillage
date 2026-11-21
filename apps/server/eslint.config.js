import tseslint from 'typescript-eslint'

/**
 * Typed rules the compiler does not enforce. A rejected promise nobody awaits or catches used to
 * reach `unhandledRejection` and stop the daemon that hosts every session (see `detach`):
 * fire-and-forget work goes through `detach(promise, label)` or ends in its own `.catch`, and a
 * bare `void promise` no longer passes.
 */
export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false, attributes: false } }],
      // `() => void promise` escapes no-floating-promises: the `void` is the arrow's value, not a statement.
      'no-restricted-syntax': ['error', {
        selector: "ArrowFunctionExpression > UnaryExpression.body[operator='void']",
        message: 'Use detach(promise, label), or a block body ending the promise in .catch.',
      }],
    },
  },
]
