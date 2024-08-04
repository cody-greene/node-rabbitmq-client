'use strict'

const ts = require('typescript-eslint')
const js = require('@eslint/js')

module.exports = ts.config({
  files: ['src/**/*.ts', '*.ts'],
  extends: [
    js.configs.recommended,
    ...ts.configs.recommended,
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-namespace': 'off',
    '@typescript-eslint/no-unsafe-declaration-merging': 'off',
    '@typescript-eslint/no-unused-vars': 'warn',
    'prefer-const': 'warn',
  }
})
