import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

export default tseslint.config(
  {
    // ui/ is a separate Vite/React app with its own toolchain: typechecked by
    // `tsc -b` during its build, not covered by this config's node/security
    // ruleset (no React plugins here). CodeQL still scans it.
    ignores: ["dist/**", "node_modules/**", "ui/**", "src/ui-assets.gen.ts"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  // Security-aware linting (OSS Readiness Plan, Part 4.3). Recommended is
  // warn-level, so findings surface in CI without blocking; ratchet warn->error
  // once existing findings are burned down (Part 2, §2.4).
  security.configs.recommended,
  {
    rules: {
      // A leading underscore marks an intentionally-unused binding (discarded
      // destructure keys, no-op callback params).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
