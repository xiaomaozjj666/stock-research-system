import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// 说明：TypeScript 7.0 当前无可用版本的 typescript-eslint 支持（其最新版仅支持 TS ≤6）。
// 因此 ESLint 仅负责 JS/JSON 与代码风格；TypeScript 文件的静态分析交由 `tsc --noEmit`
// （TS 7 + strict）作为权威门禁。待 typescript-eslint 支持 TS ≥7.1 后可恢复 TS 规则。
//
// 覆盖范围（2026-09 核对，避免出现"无人检查"的空洞）：
//   - 本配置覆盖全部 JS 文件，**包括 e2e/**、scripts/**、根级 *.mjs**（无 files 限制，
//     故 `eslint .` 会连带检查 scripts/dev.mjs、eslint.config.mjs 等）；
//   - e2e/**、server/src、client/src 中的 .ts/.tsx 由 oxlint（见 package.json 的 lint
//     脚本）+ `tsc --noEmit` 覆盖；
//   - **scripts/** 下没有 .ts**，因此 scripts/ 已由 ESLint + Prettier 双重覆盖。
// 注意：不要为了省事去掉下方 `**/*.ts` 忽略——本配置是纯 JS 规则集（js.configs.recommended
// + globals），无 TS parser，直接放开会让全仓库 TS 文件因解析失败而报错（把门禁变红）。
export default [
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/cache/**',
      '**/coverage/**',
      // TypeScript 文件交由 tsc/oxlint 静态分析，避免 ESLint 用 espree 解析 TS 语法报错
      // （本配置无 TS parser，放开会全线解析失败；TS 已由 oxlint + tsc 覆盖）
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
