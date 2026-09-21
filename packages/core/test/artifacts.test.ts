import { describe, expect, test } from "vitest";
import { contentHash, countLines, InvalidPatternError, searchContent, sliceByLines } from "../src/artifacts";

describe("sliceByLines", () => {
  test("windows are 1-indexed and inclusive", () => {
    const content = "a\nb\nc";
    expect(sliceByLines(content, 1, 2)).toEqual({ text: "a\nb", startLine: 1, endLine: 2, totalLines: 3 });
    expect(sliceByLines(content, 2, 1)).toEqual({ text: "b", startLine: 2, endLine: 2, totalLines: 3 });
    expect(sliceByLines(content, 3, 10)).toEqual({ text: "c", startLine: 3, endLine: 3, totalLines: 3 });
  });

  test("past-the-end returns an empty window instead of throwing", () => {
    expect(sliceByLines("a\nb", 5, 3)).toEqual({ text: "", startLine: 5, endLine: 4, totalLines: 2 });
    expect(sliceByLines("", 1, 5).totalLines).toBe(0);
    expect(sliceByLines("", 1, 5).text).toBe("");
  });

  test("a trailing newline does not create a phantom line", () => {
    expect(countLines("a\nb\n")).toBe(2);
    expect(sliceByLines("a\nb\n", 2, 1).text).toBe("b");
  });

  test("unicode content round-trips exactly", () => {
    const lines = ["héllo 🌍 monde", "日本語のテキスト", "emoji 👩‍💻🚀 tail", "Ωμέγα"];
    const content = lines.join("\n");
    expect(sliceByLines(content, 1, 10).text).toBe(content);
    expect(sliceByLines(content, 2, 2).text).toBe(`${lines[1]}\n${lines[2]}`);
    expect(countLines(content)).toBe(4);
    expect(contentHash(content)).toBe(contentHash(lines.join("\n")));
  });
});

describe("searchContent", () => {
  test("reports exact 1-indexed line numbers", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n");
    const result = searchContent(content, "line-(7|9)");
    expect(result.matches).toEqual([
      { line: 7, text: "line-7" },
      { line: 9, text: "line-9" },
    ]);
    expect(result.totalMatches).toBe(2);
    expect(result.truncated).toBe(false);
  });

  test("caps returned matches at limit but counts all of them", () => {
    const content = Array.from({ length: 10 }, (_, i) => `hit-${i + 1}`).join("\n");
    const result = searchContent(content, "hit-", 3);
    expect(result.matches).toHaveLength(3);
    expect(result.matches[0]).toEqual({ line: 1, text: "hit-1" });
    expect(result.totalMatches).toBe(10);
    expect(result.truncated).toBe(true);
  });

  test("no matches is not truncated", () => {
    const result = searchContent("a\nb\nc", "zzz");
    expect(result.matches).toEqual([]);
    expect(result.totalMatches).toBe(0);
    expect(result.truncated).toBe(false);
  });

  test("invalid regex raises a typed error", () => {
    expect(() => searchContent("a", "(")).toThrow(InvalidPatternError);
    try {
      searchContent("a", "(unclosed");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPatternError);
      expect((error as InvalidPatternError).name).toBe("InvalidPatternError");
      expect((error as InvalidPatternError).pattern).toBe("(unclosed");
    }
  });
});

describe("contentHash", () => {
  test("is stable for identical content and differs for different content", () => {
    expect(contentHash("same")).toBe(contentHash("same"));
    expect(contentHash("same")).toMatch(/^[\da-f]{64}$/);
    expect(contentHash("same")).not.toBe(contentHash("other"));
    expect(contentHash("a\nb")).not.toBe(contentHash("a\nb\n"));
  });
});
