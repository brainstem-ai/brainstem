import { createBitmap, type ReflexEngine, type SelectDecision, type SelectInput } from "@brainstem/core";
import type { CapabilityRegistry } from "./registry";

export interface SelectTrigger {
  reason: "initial" | "task_update" | "discovery" | "registry_change" | "new_failure_class" | "manual_refresh";
}

export class SelectDriver {
  readonly #registry: CapabilityRegistry;
  readonly #engine: ReflexEngine;
  readonly #minRefreshIntervalMs: number;
  #lastDecision?: SelectDecision;
  #lastCatalogHash?: string;
  #lastRefreshAt = 0;

  constructor(deps: { registry: CapabilityRegistry; engine: ReflexEngine; minRefreshIntervalMs?: number }) {
    this.#registry = deps.registry;
    this.#engine = deps.engine;
    this.#minRefreshIntervalMs = deps.minRefreshIntervalMs ?? 5_000;
  }

  shouldRefresh(trigger: SelectTrigger, now: number): boolean {
    if (trigger.reason === "discovery" || trigger.reason === "manual_refresh") return true;
    if (this.#lastRefreshAt === 0) return true;
    return now - this.#lastRefreshAt >= this.#minRefreshIntervalMs;
  }

  async refresh(
    input: { task: string; recent: string[]; discoveryQuery?: string },
    trigger: SelectTrigger,
  ): Promise<SelectDecision> {
    const now = Date.now();
    if (!this.shouldRefresh(trigger, now)) {
      return this.#lastDecision ?? emptyDecision(this.#registry.snapshot());
    }
    this.#lastRefreshAt = now;

    const catalog = this.#registry.snapshot();
    if (this.#lastCatalogHash !== undefined && this.#lastCatalogHash !== catalog.catalogHash) {
      this.#lastDecision = undefined;
    }
    this.#lastCatalogHash = catalog.catalogHash;

    const ws = this.#registry.workingSet();
    const current = this.#lastDecision?.recommended ?? createBitmap(catalog.catalogHash, catalog.entries.length);
    const selectInput: SelectInput = {
      task: input.task,
      recent: input.recent,
      catalog,
      available: ws.available,
      baseline: ws.baseline,
      explicit: ws.explicit,
      current,
      discoveryQuery: input.discoveryQuery,
    };
    const decision = await this.#engine.select(selectInput);
    this.#lastDecision = decision;
    return decision;
  }

  currentDecision(): SelectDecision | undefined {
    return this.#lastDecision;
  }
}

function emptyDecision(catalog: import("@brainstem/core").CapabilityCatalog): SelectDecision {
  const bm = createBitmap(catalog.catalogHash, catalog.entries.length);
  return { evaluated: bm, recommended: bm, scores: {}, reasons: {}, status: "ok", batches: 0 };
}
