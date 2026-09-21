import { hashAction, toIds, type CapabilityDescriptor, type WorkingSet } from "@brainstem/core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CapabilityRegistry } from "./registry";

export interface BuiltContext {
  tools: AgentTool[];
  activeIds: string[];
  instructionBlock: string | undefined;
  instructionHash: string | undefined;
}

export function buildActiveContext(
  registry: CapabilityRegistry,
  ws: WorkingSet,
  onWarn?: (msg: string) => void,
): BuiltContext {
  const catalog = registry.snapshot();
  const activeIds = toIds(ws.active, catalog.entries);
  const byId = new Map(catalog.entries.map((d) => [d.id, d] as const));

  const tools: AgentTool[] = [];
  for (const id of activeIds) {
    const descriptor = byId.get(id);
    if (descriptor?.kind !== "tool") continue;
    const impl = registry.impl(id);
    if (impl === null || impl === undefined) {
      onWarn?.(`active tool "${id}" has no implementation attached; skipping`);
      continue;
    }
    tools.push(impl as AgentTool);
  }

  const skillIds = activeIds.filter((id) => byId.get(id)?.kind === "skill").sort();
  let instructionBlock: string | undefined;
  if (skillIds.length > 0) {
    const blocks = skillIds.map((id) => {
      const instructions = registry.instructionsFor(id) ?? "";
      return `## Skill: ${id}\n${instructions}`;
    });
    instructionBlock = [
      "The following skill instructions supplement, and never override, the harness contract above.",
      ...blocks,
    ].join("\n\n");
  }

  const instructionHash = instructionBlock !== undefined ? hashAction(instructionBlock) : undefined;

  return { tools, activeIds, instructionBlock, instructionHash };
}
