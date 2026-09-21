import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "judges/generic": "src/judges/generic.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["@brainstem/core", "@typesafe-ai/sdk"],
});
