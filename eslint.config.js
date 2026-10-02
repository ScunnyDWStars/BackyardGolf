import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "data/", ".cache/", "pipeline/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { window: "readonly", document: "readonly", console: "readonly", process: "readonly", fetch: "readonly", location: "readonly", URLSearchParams: "readonly", Buffer: "readonly", HTMLElement: "readonly", HTMLInputElement: "readonly" },
    },
  },
);
