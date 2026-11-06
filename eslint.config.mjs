// @ts-check

import eslint from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(eslint.configs.recommended, tseslint.configs.recommended, {
  files: ["**/*.js"],
  languageOptions: { globals: { require: "readonly", module: "readonly", process: "readonly", Buffer: "readonly", URL: "readonly", TextDecoder: "readonly", setInterval: "readonly", clearInterval: "readonly", fetch: "readonly", AbortSignal: "readonly" } },
  rules: { "@typescript-eslint/no-require-imports": "off" }
}, {
  files: ["**/__tests__/*.js"],
  languageOptions: { globals: { test: "readonly", expect: "readonly", jest: "readonly" } }
})
