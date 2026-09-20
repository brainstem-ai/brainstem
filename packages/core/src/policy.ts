import { DEFAULT_JEV_MODEL } from "./providers/jev";

export const DEFAULT_TRUST = 0.3;

export interface Policy {
  model: string;
  confidenceFloor: number;
  gate: {
    autoConfidence: number;
    askDestructive: number;
    denyDestructive: number;
    credentialNoul: number;
    exfilNoul: number;
    offTaskOnTask: number;
  };
  sanitize: {
    review: number;
    action: number;
    severityBlock: number;
  };
  pulse: {
    repeatNoul: number;
    stuckNoul: number;
    progressNoul: number;
    stopScore: number;
  };
  steer: {
    miniConfidence: number;
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function policyForTrust(trust: number): Policy {
  const t = clamp(trust, 0, 1);
  return {
    model: DEFAULT_JEV_MODEL,
    confidenceFloor: 0.5,
    gate: {
      autoConfidence: 0.95 - 0.35 * t,
      askDestructive: 0.5,
      denyDestructive: 1.5,
      credentialNoul: 0.5,
      exfilNoul: 0.5,
      offTaskOnTask: 0.3,
    },
  sanitize: {
    review: 0.35,
    action: 0.7,
    severityBlock: 2.0,
  },
  pulse: {
    repeatNoul: 0.7,
    stuckNoul: 0.7,
    progressNoul: 0.3,
    stopScore: 0.5,
  },
  steer: {
    miniConfidence: 0.6,
  },
};
}
