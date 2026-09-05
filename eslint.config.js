import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: [".cache/**", "dist/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  { files: ["scripts/**/*.mjs"], languageOptions: { globals: { process: "readonly", console: "readonly", Buffer: "readonly", structuredClone: "readonly", URL: "readonly", setTimeout: "readonly", clearTimeout: "readonly" } }, rules: { "no-undef": "error" } },
  { rules: { "@typescript-eslint/no-explicit-any": "off" } }
);
