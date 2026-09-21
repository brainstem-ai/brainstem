import { describe, expect, test } from "vitest";
import { dependencyClosure, splitIntoSections } from "../src/output-sections";

describe("splitIntoSections", () => {
  test("blank-line-delimited text splits into sections in source order with verbatim text", () => {
    const content = [
      "First paragraph",
      "still first",
      "",
      "  Second paragraph",
      "  indented",
      "",
      "Third paragraph",
    ].join("\n");

    const manifest = splitIntoSections("run:1", content);
    expect(manifest.entries).toHaveLength(3);
    expect(manifest.entries[0]!.text).toBe("First paragraph\nstill first");
    expect(manifest.entries[1]!.text).toBe("  Second paragraph\n  indented");
    expect(manifest.entries[2]!.text).toBe("Third paragraph");
    expect(manifest.entries.map((s) => s.id)).toEqual(["run:1:0", "run:1:1", "run:1:2"]);
  });

  test("header line followed by indented block produces a child section", () => {
    const content = "FAIL auth.test.ts:\n  AssertionError: expected true to equal false";
    const manifest = splitIntoSections("test-run", content);
    expect(manifest.entries).toHaveLength(2);
    const header = manifest.entries[0]!;
    const child = manifest.entries[1]!;
    expect(header.text).toBe("FAIL auth.test.ts:");
    expect(header.requires).toEqual([]);
    expect(child.requires).toEqual([header.id]);
    expect(dependencyClosure(manifest, [child.id])).toEqual([header.id, child.id]);
  });

  test("dense unstructured content falls back to fixed line windows", () => {
    const lines = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`);
    const manifest = splitIntoSections("trace", lines.join("\n"));
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0]!.text.split("\n")).toHaveLength(40);
    expect(manifest.entries[1]!.text.split("\n")).toHaveLength(5);
    for (const section of manifest.entries) {
      expect(section.requires).toEqual([]);
    }
  });

  test("byte offsets differ from UTF-16 length for multi-byte characters", () => {
    const content = "start\n\nemoji: 🚀\nCJK: 中文";
    const manifest = splitIntoSections("unicode", content);
    const section = manifest.entries.find((s) => s.text.includes("🚀"))!;
    const byteSpan = section.endByte - section.startByte;
    expect(byteSpan).toBeGreaterThan(section.text.length);
    expect(byteSpan).toBe(Buffer.byteLength(section.text, "utf8"));
  });

  test("stdout and stderr split independently with distinct ids and no shared requires", () => {
    const content = "same text\n\nother block";
    const stdout = splitIntoSections("cmd:stdout", content);
    const stderr = splitIntoSections("cmd:stderr", content);
    expect(stdout.entries[0]!.id).toBe("cmd:stdout:0");
    expect(stderr.entries[0]!.id).toBe("cmd:stderr:0");
    expect(stdout.entries[0]!.requires).toEqual([]);
    expect(stderr.entries[0]!.requires).toEqual([]);
    expect(stdout.entries.map((s) => s.id)).not.toEqual(stderr.entries.map((s) => s.id));
  });
});

describe("dependencyClosure", () => {
  test("returns manifest-order ids including selected and transitive dependencies", () => {
    const manifest = splitIntoSections(
      "deps",
      [
        "Header:",
        "  child one",
        "    grandchild",
        "",
        "orphan paragraph",
      ].join("\n"),
    );
    const selected = [manifest.entries[1]!.id];
    const closure = dependencyClosure(manifest, selected);
    expect(closure).toContain(selected[0]);
    expect(closure).toContain(manifest.entries[0]!.id);
    expect(closure).not.toContain(manifest.entries[manifest.entries.length - 1]!.id);
  });
});
