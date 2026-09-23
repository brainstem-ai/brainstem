import { defineConfig } from "tsdown";
import { buildConfigs } from "./tsdown.config.ts";

export default defineConfig(
  buildConfigs.map((config) => ({
    ...config,
    attw: config.name !== "cli",
    publint: true,
  })),
);
