import { hashAction } from "./evidence";
import { cloneBitmap, createBitmap, fromIds, getBit, setBit, toIds, type CapabilityBitmap } from "./bitmap";

export const CAPCAT_NAMESPACE = "capcat/1";
export const SECT_NAMESPACE = "sect/1";

export interface CapabilityDescriptor {
  id: string;
  kind: "tool" | "skill";
  version: string;
  description: string;
  useWhen: string[];
  avoidWhen: string[];
  requires: string[];
  alwaysAvailable: boolean;
  contentHash: string;
}

export interface CapabilityCatalog {
  catalogHash: string;
  entries: readonly CapabilityDescriptor[];
}

export function compileCatalog(descriptors: CapabilityDescriptor[], namespace: string = CAPCAT_NAMESPACE): CapabilityCatalog {
  const sorted = [...descriptors].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map<string, CapabilityDescriptor>();
  for (const d of sorted) {
    if (byId.has(d.id)) throw new Error(`duplicate capability id: "${d.id}"`);
    byId.set(d.id, d);
  }
  for (const d of sorted) {
    for (const r of d.requires) {
      if (!byId.has(r)) throw new Error(`capability "${d.id}" requires unknown id "${r}"`);
    }
  }
  const done = new Set<string>();
  const visiting: string[] = [];
  const onPath = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (onPath.has(id)) {
      throw new Error(`dependency cycle: ${[...visiting, id].join(" -> ")}`);
    }
    onPath.add(id);
    visiting.push(id);
    for (const r of byId.get(id)!.requires) visit(r);
    visiting.pop();
    onPath.delete(id);
    done.add(id);
  };
  for (const d of sorted) visit(d.id);
  const catalogHash = hashAction({ schema: namespace, descriptors: sorted });
  return { catalogHash, entries: Object.freeze(sorted.map((d) => Object.freeze({ ...d }))) };
}

export type SeedSource = "baseline" | "explicit" | "pinned" | "recommended";

export interface WorkingSet {
  available: CapabilityBitmap;
  baseline: CapabilityBitmap;
  explicit: CapabilityBitmap;
  evaluated: CapabilityBitmap;
  recommended: CapabilityBitmap;
  active: CapabilityBitmap;
}

export interface ComputeActiveOpts {
  pinned?: string[];
}

export interface ComputeActiveResult {
  active: CapabilityBitmap;
  unmetExplicit: string[];
  dropped: { id: string; reason: string }[];
}

function assertMaskFor(catalog: CapabilityCatalog, bm: CapabilityBitmap, name: string): void {
  if (bm.catalogHash !== catalog.catalogHash) {
    throw new Error(`${name}: catalogHash mismatch with catalog`);
  }
  if (bm.bitLength !== catalog.entries.length) {
    throw new Error(`${name}: bitLength ${bm.bitLength} does not match catalog size ${catalog.entries.length}`);
  }
}

export function computeActive(
  catalog: CapabilityCatalog,
  working: Omit<WorkingSet, "active">,
  opts: ComputeActiveOpts = {},
): ComputeActiveResult {
  assertMaskFor(catalog, working.available, "available");
  assertMaskFor(catalog, working.baseline, "baseline");
  assertMaskFor(catalog, working.explicit, "explicit");
  assertMaskFor(catalog, working.evaluated, "evaluated");
  assertMaskFor(catalog, working.recommended, "recommended");
  const n = catalog.entries.length;
  const indexById = new Map(catalog.entries.map((d, i) => [d.id, i] as const));

  const source = new Map<number, SeedSource>();
  const classify = (bm: CapabilityBitmap, src: SeedSource): void => {
    for (let i = 0; i < n; i++) {
      if (getBit(bm, i) && !source.has(i)) source.set(i, src);
    }
  };
  classify(working.explicit, "explicit");
  classify(working.baseline, "baseline");
  classify(working.recommended, "recommended");
  const seeds = new Set(source.keys());
  for (const id of opts.pinned ?? []) {
    const i = indexById.get(id);
    if (i === undefined) continue;
    if (!source.has(i)) source.set(i, "pinned");
    seeds.add(i);
  }

  // Dependency-closed activation over the seed union: deps are pulled in transitively and
  // rejections (unavailable or failed requires) cascade back to dependents.
  const active = new Set<number>();
  const rejected = new Map<number, string>();
  const inProgress = new Set<number>();
  const activate = (i: number): boolean => {
    if (active.has(i)) return true;
    if (rejected.has(i)) return false;
    if (inProgress.has(i)) return true;
    inProgress.add(i);
    let ok = true;
    for (const r of catalog.entries[i]!.requires) {
      const j = indexById.get(r)!;
      if (active.has(j)) continue;
      if (!getBit(working.available, j)) {
        rejected.set(i, `requires "${r}": unavailable`);
        ok = false;
        break;
      }
      if (!activate(j)) {
        rejected.set(i, `requires "${r}": ${rejected.get(j)}`);
        ok = false;
        break;
      }
    }
    inProgress.delete(i);
    if (ok) active.add(i);
    else if (!rejected.has(i)) rejected.set(i, "requires unmet");
    return ok;
  };
  for (const i of seeds) {
    if (!getBit(working.available, i)) {
      if (!rejected.has(i)) rejected.set(i, "unavailable");
      continue;
    }
    activate(i);
  }

  const activeBm = createBitmap(catalog.catalogHash, n);
  for (const i of active) setBit(activeBm, i);

  const unmetExplicit: string[] = [];
  const dropped: { id: string; reason: string }[] = [];
  for (const i of seeds) {
    if (active.has(i)) continue;
    const id = catalog.entries[i]!.id;
    const src = source.get(i)!;
    const reason = rejected.get(i) ?? "requires unmet";
    if (src === "explicit") unmetExplicit.push(id);
    else dropped.push({ id, reason });
  }
  unmetExplicit.sort();
  dropped.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { active: activeBm, unmetExplicit, dropped };
}

export function workingSetFromIds(
  catalog: CapabilityCatalog,
  masks: {
    available?: string[];
    baseline?: string[];
    explicit?: string[];
    evaluated?: string[];
    recommended?: string[];
  },
): Omit<WorkingSet, "active"> {
  const make = (ids?: string[]): CapabilityBitmap => fromIds(ids ?? [], catalog.entries, catalog.catalogHash);
  return {
    available: make(masks.available),
    baseline: make(masks.baseline),
    explicit: make(masks.explicit),
    evaluated: make(masks.evaluated),
    recommended: make(masks.recommended),
  };
}

export function activeIds(catalog: CapabilityCatalog, result: ComputeActiveResult): string[] {
  return toIds(result.active, catalog.entries);
}

export function cloneWorkingSet(working: WorkingSet): WorkingSet {
  return {
    available: cloneBitmap(working.available),
    baseline: cloneBitmap(working.baseline),
    explicit: cloneBitmap(working.explicit),
    evaluated: cloneBitmap(working.evaluated),
    recommended: cloneBitmap(working.recommended),
    active: cloneBitmap(working.active),
  };
}
