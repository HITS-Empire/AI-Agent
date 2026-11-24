import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    ignores: ["data", "dist", "build", "node_modules", "**/dist", ".secrets"],
  },
  {
    rules: {
      "no-empty": "warn",
      "no-async-promise-executor": "warn",
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
      "@typescript-eslint/no-namespace": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Ядро по заданию пишется без библиотек: только node:*, свои модули и @burmalda/shared
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!node:|@burmalda/shared$|\\.{1,2}/)",
              message:
                "packages/core — без внешних библиотек (условие лабы). Вынеси зависимость в harness-пакет.",
            },
          ],
        },
      ],
    },
  },
);
