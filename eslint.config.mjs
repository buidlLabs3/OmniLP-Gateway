import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const typeFiles = ["**/*.ts", "**/*.tsx"];

export default tseslint.config(
  {
    ignores: [
      "**/.next/**",
      "**/coverage/**",
      "**/dist/**",
      "playwright-report/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: typeFiles,
  })),
  {
    files: typeFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "server/src/store/memory.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
);
