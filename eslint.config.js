// ESLint (flat config). Scope: all first-party JavaScript. Rules are the ESLint recommended set — real bug finders
// (undefined variables, unreachable code, duplicate keys, unused variables, etc.), not stylistic opinions.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'dist/**', '.data/**'] },
  js.configs.recommended,
  { files: ['src/**/*.js', 'app/**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser, ...globals.node } } },   // src is shared: browser + server
  { files: ['api/**/*.js', 'scripts/**/*.{js,mjs}', 'tests/**/*.js', 'eslint.config.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } } },
  { files: ['sw.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.serviceworker } } },
  { rules: { 'no-empty': ['error', { allowEmptyCatch: true }], 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }] } },
  // Original planner code, left untouched on purpose:
  //  • these modules wrap their OWN exported function with an optional DEBUG-only timing hook (documented in each file);
  //  • OfflineBot keeps an unused local table from the monolith.
  { files: ['src/ai/ContextBuilder.js', 'src/core/dijkstra.js', 'src/core/optimization.js', 'src/places/PlacesService.js', 'src/rendering/renderer.js'], rules: { 'no-func-assign': 'off' } },
  { files: ['src/ai/OfflineBot.js'], rules: { 'no-unused-vars': 'off' } },
];
