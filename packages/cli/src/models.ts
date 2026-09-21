import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";

export interface ModelRegistry {
  setProvider(provider: Provider): void;
  getModel(provider: string, id: string): Model<Api> | undefined;
}

export interface ResolvedModels {
  main: Model<Api>;
  mini?: Model<Api>;
}

const PROVIDERS: Record<string, () => Provider> = {
  anthropic: anthropicProvider,
  zai: zaiProvider,
};

function parseSpec(spec: string): { provider: string; id: string } | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  if (!PROVIDERS[provider]) return undefined;
  return { provider, id };
}

function resolveOne(registry: ModelRegistry, spec: string): Model<Api> | undefined {
  const parsed = parseSpec(spec);
  if (!parsed) return undefined;
  registry.setProvider(PROVIDERS[parsed.provider]!());
  return registry.getModel(parsed.provider, parsed.id);
}

export function resolveModels(registry: ModelRegistry, mainSpec: string, miniSpec?: string): ResolvedModels {
  const main = resolveOne(registry, mainSpec);
  if (!main) throw new Error(`unknown model ${mainSpec}`);

  if (!miniSpec) return { main };

  const mini = resolveOne(registry, miniSpec);
  if (!mini) throw new Error(`mini model ${miniSpec} not found — steering disabled`);

  const mainParsed = parseSpec(mainSpec)!;
  const miniParsed = parseSpec(miniSpec)!;
  if (mainParsed.provider === miniParsed.provider && mainParsed.id === miniParsed.id) {
    return { main, mini: undefined };
  }
  return { main, mini };
}
