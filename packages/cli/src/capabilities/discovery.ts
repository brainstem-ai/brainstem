import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getBit, toIds } from "@brainstem/core";
import type { SelectDriver } from "./select-policy";
import { BASELINE_TOOL_IDS, CapabilityRegistry } from "./registry";

const FALLBACK_CAP = 20;

export interface DiscoveryDeps {
  registry: CapabilityRegistry;
  driver: SelectDriver;
  taskText: () => string;
  recentActivity: () => string[];
}

export function makeDiscoveryTool(deps: DiscoveryDeps): AgentTool {
  const params = Type.Object({
    query: Type.String({ description: "What capability are you looking for?" }),
  });

  const baselineIds = new Set<string>(BASELINE_TOOL_IDS);

  return {
    name: "find_capabilities",
    label: "Find Capabilities",
    description: "Search the capability catalog for optional tools or skills that match a query.",
    parameters: params,
    execute: async (_id, params) => {
      const { query } = params as { query: string };
      const decision = await deps.driver.refresh(
        { task: deps.taskText(), recent: deps.recentActivity(), discoveryQuery: query },
        { reason: "discovery" },
      );

      const catalog = deps.registry.snapshot();
      const evaluatedIds = new Set(toIds(decision.evaluated, catalog.entries));
      const recommendedIds = toIds(decision.recommended, catalog.entries);
      const byId = new Map(catalog.entries.map((d) => [d.id, d] as const));

      const explicitIds = new Set(toIds(deps.registry.workingSet().explicit, catalog.entries));

      if (decision.status !== "unavailable") {
        const newlyRecommended = recommendedIds.filter((id) => !baselineIds.has(id) && !explicitIds.has(id));
        if (newlyRecommended.length > 0) {
          deps.registry.pin(newlyRecommended);
          // Pin is the activation source for discovered capabilities; keep the driver's
          // recommended bitmap from also seeding them so unpin is authoritative.
          deps.driver.clearRecommended(newlyRecommended);
        }

        if (recommendedIds.length === 0) {
          return {
            content: [{ type: "text", text: `no capability in the catalog matches '${query}'` }],
            details: { matched: [] },
          };
        }

        const lines = recommendedIds
          .filter((id) => evaluatedIds.has(id))
          .map((id) => {
            const d = byId.get(id);
            return `${id}: ${d?.description ?? ""}`;
          });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { matched: recommendedIds },
        };
      }

      const ws = deps.registry.workingSet();
      const indexById = new Map(catalog.entries.map((d, i) => [d.id, i] as const));
      const eligible = catalog.entries
        .filter((d) => !baselineIds.has(d.id) && !explicitIds.has(d.id))
        .filter((d) => getBit(ws.available, indexById.get(d.id) ?? -1))
        .slice(0, FALLBACK_CAP)
        .map((d) => `${d.id}: ${d.description}`);

      return {
        content: [
          {
            type: "text",
            text: [
              "Jev is unavailable; showing all eligible capabilities unranked — request one explicitly if it matches:",
              ...eligible,
            ].join("\n"),
          },
        ],
        details: { unavailable: true, candidates: eligible.map((line) => line.split(":")[0]) },
      };
    },
  };
}
