// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import js from "@eslint/js";
import solid from "eslint-plugin-solid/configs/typescript";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "src/api/schema.d.ts",
      "test-results/",
      "playwright-report/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    ...solid,
    languageOptions: {
      ...solid.languageOptions,
      globals: { ...globals.browser },
    },
  },
  {
    // Tests read stores outside any tracked scope on purpose.
    files: ["src/**/*.test.ts"],
    rules: { "solid/reactivity": "off" },
  },
  {
    // Solid assigns `ref={el}` variables itself: the compiler, not the code.
    files: ["src/**/*.tsx"],
    rules: { "no-unassigned-vars": "off" },
  },
  {
    files: ["*.config.{js,ts}", "e2e/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Playwright fixtures take `({}, use)` when they need no other fixture.
    files: ["e2e/**/*.ts"],
    rules: { "no-empty-pattern": "off" },
  },
  {
    rules: {
      // Untrusted text stays text (AGENTS.md rule 6).
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='innerHTML']",
          message: "innerHTML is banned: render untrusted text as text (AGENTS.md rule 6).",
        },
        {
          selector: "MemberExpression[property.name='innerHTML']",
          message: "innerHTML is banned: render untrusted text as text (AGENTS.md rule 6).",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
