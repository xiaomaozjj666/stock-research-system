import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// 说明：TypeScript 7.0 当前无可用版本的 typescript-eslint 支持（其最新版仅支持 TS ≤6）。
// 因此 ESLint 仅负责 JS/JSON 与代码风格；TypeScript 文件的静态分析交由 `tsc --noEmit`
// （TS 7 + strict）作为权威门禁。待 typescript-eslint 支持 TS ≥7.1 后可恢复 TS 规则。
export default [
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/cache/**',
      '**/coverage/**',
      // TypeScript 文件交由 tsc 静态分析，避免 ESLint 用 espree 解析 TS 语法报错
      '**/*.ts',
      '**/*.tsx',
      '**/*.mts',
      '**/*.cts',
    ],
  },
  js.configs.recommended,
  prettier,
  {
    // 浏览器 + Node 全局变量（前端/后端共用，避免 no-undef 误报）
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      // 空 catch 在数据采集容错场景中常见，允许
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      'no-var': 'error',
    },
  },
];
