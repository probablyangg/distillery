import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@distillery/contracts": `${root}packages/contracts/src/index.ts`,
      "@distillery/evidence": `${root}packages/evidence/src/index.ts`,
      "@distillery/validation": `${root}packages/validation/src/index.ts`,
      "@distillery/model-gateway": `${root}packages/model-gateway/src/index.ts`,
      "@distillery/loop": `${root}packages/loop/src/index.ts`,
      "@distillery/db": `${root}packages/db/src/index.ts`,
      "@distillery/memory-generation": `${root}packages/memory-generation/src/index.ts`,
      "@distillery/memory-retrieval": `${root}packages/memory-retrieval/src/index.ts`,
      "@distillery/memory-synthesis": `${root}packages/memory-synthesis/src/index.ts`,
      "@distillery/slack-connector": `${root}packages/slack-connector/src/index.ts`,
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
  },
});
