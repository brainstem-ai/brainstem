import { describe, expect, test } from "vitest";
import type { Provider } from "@earendil-works/pi-ai";
import { resolveModels, type ModelRegistry } from "../src/models";

interface FakeModel {
  id: string;
}

const CATALOG: Record<string, FakeModel> = {
  "zai/glm-5.3": { id: "glm-5.3" },
  "zai/glm-5.3-flash": { id: "glm-5.3-flash" },
  "anthropic/claude-opus": { id: "claude-opus" },
};

function fakeRegistry(): ModelRegistry & { providersSet: string[] } {
  const providersSet: string[] = [];
  return {
    providersSet,
    setProvider(provider: Provider) {
      providersSet.push((provider as unknown as { id?: string }).id ?? String(provider));
    },
    getModel(provider: string, id: string) {
      return CATALOG[`${provider}/${id}`] as never;
    },
  };
}

describe("resolveModels", () => {
  test("resolves distinct same-provider models", () => {
    const registry = fakeRegistry();
    const { main, mini } = resolveModels(registry, "zai/glm-5.3", "zai/glm-5.3-flash");
    expect((main as unknown as FakeModel).id).toBe("glm-5.3");
    expect((mini as unknown as FakeModel).id).toBe("glm-5.3-flash");
  });

  test("registers each spec's provider independently", () => {
    const registry = fakeRegistry();
    resolveModels(registry, "zai/glm-5.3", "anthropic/claude-opus");
    expect(registry.providersSet).toHaveLength(2);
  });

  test("identical specs disable routing (mini undefined)", () => {
    const registry = fakeRegistry();
    const { main, mini } = resolveModels(registry, "zai/glm-5.3", "zai/glm-5.3");
    expect((main as unknown as FakeModel).id).toBe("glm-5.3");
    expect(mini).toBeUndefined();
  });

  test("unknown mini spec throws a clear error", () => {
    const registry = fakeRegistry();
    expect(() => resolveModels(registry, "zai/glm-5.3", "zai/nope")).toThrow(/mini model zai\/nope/);
  });

  test("unknown main spec throws", () => {
    const registry = fakeRegistry();
    expect(() => resolveModels(registry, "zai/nope")).toThrow(/unknown model zai\/nope/);
  });
});
