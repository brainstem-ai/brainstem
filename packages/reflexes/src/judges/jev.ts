import { TypeSafeClient } from "@typesafe-ai/sdk";
import { jevSystemOne, type SystemOne } from "@brainstem/core";

export interface JevJudgeOptions {
  /** Falls back to TYPESAFE_API_KEY — TypeSafeClient's own existing env behavior, not reimplemented here. */
  apiKey?: string;
  model?: string;
}

export function jevJudge(options: JevJudgeOptions = {}): SystemOne {
  return jevSystemOne(new TypeSafeClient({ apiKey: options.apiKey }), options.model);
}
