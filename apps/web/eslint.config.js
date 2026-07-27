import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

/**
 * Lint volontairement réduit aux règles que le typecheck ne peut pas couvrir.
 *
 * Le compilateur ne voit rien d'un hook appelé après un retour anticipé : c'est une
 * erreur d'exécution qui n'apparaît que dans le navigateur, sous forme d'un message
 * React minifié. Ces deux règles la transforment en échec de build.
 */
export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
]
