import {
  compileCatalog,
  computeActive,
  createBitmap,
  fromIds,
  hashAction,
  type CapabilityCatalog,
  type CapabilityDescriptor,
  type ComputeActiveOpts,
  type ComputeActiveResult,
  type WorkingSet,
} from "@brainstem/core";

export interface RegisterInput {
  id: string;
  kind: "tool" | "skill";
  version: string;
  description: string;
  useWhen?: string[];
  avoidWhen?: string[];
  requires?: string[];
  alwaysAvailable?: boolean;
  schema?: unknown;
}

export const BASELINE_TOOL_IDS = [
  "tool:bash",
  "tool:read",
  "tool:write",
  "tool:grep",
  "tool:glob",
  "tool:read_output",
  "tool:search_output",
] as const;

const BASELINE_TOOLS: RegisterInput[] = [
  {
    id: "tool:bash",
    kind: "tool",
    version: "1.0.0",
    description: "Run a shell command in the project directory and return its output.",
    useWhen: ["You need to run build, test, or git commands"],
    avoidWhen: ["A dedicated read or write tool covers the task"],
    alwaysAvailable: true,
    schema: { name: "bash", description: "Run a shell command in the project directory and return its output." },
  },
  {
    id: "tool:read",
    kind: "tool",
    version: "1.0.0",
    description: "Read a file's contents.",
    useWhen: ["You need to inspect file contents"],
    avoidWhen: ["The target is a directory listing (use glob)"],
    alwaysAvailable: true,
    schema: { name: "read", description: "Read a file's contents." },
  },
  {
    id: "tool:write",
    kind: "tool",
    version: "1.0.0",
    description: "Create or overwrite a file with the given content.",
    useWhen: ["You need to create or replace a whole file"],
    avoidWhen: ["You only need a small in-place edit"],
    alwaysAvailable: true,
    schema: { name: "write", description: "Create or overwrite a file with the given content." },
  },
  {
    id: "tool:grep",
    kind: "tool",
    version: "1.0.0",
    description: "Search file contents with a regular expression.",
    useWhen: ["You need to find code by pattern"],
    avoidWhen: ["You know the exact file path"],
    alwaysAvailable: true,
    schema: { name: "grep", description: "Search file contents with a regular expression." },
  },
  {
    id: "tool:glob",
    kind: "tool",
    version: "1.0.0",
    description: "List files matching a glob pattern.",
    useWhen: ["You need to discover files by name pattern"],
    avoidWhen: ["You need file contents (use read)"],
    alwaysAvailable: true,
    schema: { name: "glob", description: "List files matching a glob pattern." },
  },
  {
    id: "tool:read_output",
    kind: "tool",
    version: "1.0.0",
    description: "Recover lines from a previously captured tool output artifact.",
    useWhen: ["A capture notice says output was bounded and you need omitted lines"],
    avoidWhen: ["The content is on disk (use read)"],
    alwaysAvailable: true,
    schema: { name: "read_output", description: "Recover lines from a previously captured tool output artifact." },
  },
  {
    id: "tool:search_output",
    kind: "tool",
    version: "1.0.0",
    description: "Search a previously captured tool output artifact with a regular expression.",
    useWhen: ["You need to locate content inside a bounded capture"],
    avoidWhen: ["The content is on disk (use grep)"],
    alwaysAvailable: true,
    schema: { name: "search_output", description: "Search a previously captured tool output artifact with a regular expression." },
  },
];

export class CapabilityRegistry {
  #inputs = new Map<string, RegisterInput>();
  #impls = new Map<string, unknown>();
  #configuredAvailability = new Map<string, boolean>();
  #explicit: string[] = [];

  constructor() {
    for (const tool of BASELINE_TOOLS) this.register(tool, null);
  }

  register(input: RegisterInput, impl: unknown): void {
    if (this.#inputs.has(input.id)) {
      throw new Error(`capability already registered: "${input.id}"`);
    }
    this.#inputs.set(input.id, input);
    this.#impls.set(input.id, impl);
  }

  impl(id: string): unknown {
    return this.#impls.get(id);
  }

  markAvailability(id: string, available: boolean): void {
    if (!this.#inputs.has(id)) {
      throw new Error(`cannot mark availability for unknown capability: "${id}"`);
    }
    this.#configuredAvailability.set(id, available);
  }

  setExplicit(ids: string[]): void {
    for (const id of ids) {
      if (!this.#inputs.has(id)) {
        throw new Error(`cannot select unknown capability: "${id}"`);
      }
    }
    this.#explicit = [...ids];
  }

  snapshot(): CapabilityCatalog {
    const descriptors: CapabilityDescriptor[] = [...this.#inputs.values()].map((input) => ({
      id: input.id,
      kind: input.kind,
      version: input.version,
      description: input.description,
      useWhen: input.useWhen ?? [],
      avoidWhen: input.avoidWhen ?? [],
      requires: input.requires ?? [],
      alwaysAvailable: input.alwaysAvailable ?? false,
      contentHash: hashAction(input.schema ?? null),
    }));
    return compileCatalog(descriptors);
  }

  catalogFingerprint(): string {
    return this.snapshot().catalogHash;
  }

  snapshotDescriptors(): CapabilityDescriptor[] {
    return [...this.snapshot().entries];
  }

  workingSet(opts: ComputeActiveOpts = {}): WorkingSet {
    const catalog = this.snapshot();
    const availableIds = catalog.entries
      .filter((d) => d.alwaysAvailable || this.#configuredAvailability.get(d.id) !== false)
      .map((d) => d.id);
    const available = fromIds(availableIds, catalog.entries, catalog.catalogHash);
    const baseline = fromIds(
      BASELINE_TOOL_IDS.filter((id) => catalog.entries.some((d) => d.id === id)),
      catalog.entries,
      catalog.catalogHash,
    );
    const explicit = fromIds(this.#explicit, catalog.entries, catalog.catalogHash);
    const evaluated = createBitmap(catalog.catalogHash, catalog.entries.length);
    const recommended = createBitmap(catalog.catalogHash, catalog.entries.length);
    const masks = { available, baseline, explicit, evaluated, recommended };
    const active = computeActive(catalog, masks, opts).active;
    return { ...masks, active };
  }

  evaluate(opts: ComputeActiveOpts = {}): { catalog: CapabilityCatalog; result: ComputeActiveResult } {
    const catalog = this.snapshot();
    const ws = this.workingSet(opts);
    const { active: _active, ...masks } = ws;
    return { catalog, result: computeActive(catalog, masks, opts) };
  }
}
