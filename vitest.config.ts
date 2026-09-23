import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@brainstem/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@brainstem/pi-adapter": fileURLToPath(new URL("./packages/pi-adapter/src/index.ts", import.meta.url)),
      "@brainstem/reflexes": fileURLToPath(new URL("./packages/reflexes/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
