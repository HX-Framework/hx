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
      // The shape behind the 2026-10-14 `hx watch` freeze: a single-flight
      // slot holding the promise of an async IIFE whose own `finally` clears
      // the slot. Flagged whenever such an IIFE is stored at all; see
      // singleFlight in src/upload-scheduler.ts for the safe form.
      "no-restricted-syntax": [
        "error",
        ...["AssignmentExpression", "VariableDeclarator"].map((parent) => ({
          selector: `${parent} > CallExpression[callee.async=true]:has(TryStatement[finalizer])`,
          message:
            "Do not store the promise of an async IIFE that contains a try/finally. If the finally clears " +
            "the variable the promise is stored in, a body that returns before its first await clears it " +
            "BEFORE the assignment, and a settled promise stays in the slot forever. Clear the slot with " +
            ".finally() on the promise instead (see singleFlight in src/upload-scheduler.ts).",
        })),
      ],
    },
  },
);
