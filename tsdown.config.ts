import { defineConfig, type UserConfig } from "tsdown";

const library: UserConfig = {
  clean: true,
  dts: true,
  failOnWarn: true,
  format: "esm",
  platform: "node",
  sourcemap: true,
  target: "es2022",
  tsconfig: "tsconfig.build.json",
};

export default defineConfig([
  {
    ...library,
    cwd: "packages/core",
    name: "core",
  },
  {
    ...library,
    cwd: "packages/reflexes",
    name: "reflexes",
    entry: {
      index: "src/index.ts",
      "judges/generic": "src/judges/generic.ts",
    },
  },
  {
    ...library,
    cwd: "packages/pi-adapter",
    name: "pi-adapter",
  },
  {
    ...library,
    cwd: "packages/cli",
    dts: false,
    entry: "src/main.ts",
    name: "cli",
  },
]);
