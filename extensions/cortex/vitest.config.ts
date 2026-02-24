import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Local vitest config for running tests from within `extensions/cortex/`.
// The repo-root vitest config assumes it is executed from the repo root.
// Pipeline hooks sometimes run `pnpm vitest ...` from this directory, so we
// provide an include glob that matches local relative paths like:
//   sop-generation/__tests__/auto-sop-generator.test.ts

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/vendor/**",
      "**/*.live.test.ts",
      "**/*.e2e.test.ts",
      "adversarial/suites/*.test.ts", // runner-owned scenario files (no direct vitest suites)
    ],
    // No setupFiles here; repo-root tests use `test/setup.ts` from repo root.
  },
});
