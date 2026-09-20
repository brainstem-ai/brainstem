export const CORE_VERSION = "0.1.0";

export * from "./types";
export { jevSystemOne, DEFAULT_JEV_MODEL } from "./providers/jev";
export { mockSystemOne, noulAnswer, choiceAnswer, scoreAnswer } from "./providers/mock";
export type { MockSystemOne } from "./providers/mock";
