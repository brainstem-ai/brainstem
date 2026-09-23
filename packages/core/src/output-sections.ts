import { hashAction } from "./evidence";
import { SECT_NAMESPACE } from "./capabilities";

export interface OutputSection {
  id: string;
  artifactId: string;
  startByte: number;
  endByte: number;
  text: string;
  requires: string[];
}

export interface SectionManifest {
  catalogHash: string;
  entries: readonly OutputSection[];
}

const LINE_WINDOW = 40;

function isHeaderLine(firstLine: string, secondLine?: string): boolean {
  if (/:\s*$/.test(firstLine)) return true;
  if (/^(PASS|FAIL|ok|not ok)\b/i.test(firstLine)) return true;
  if (/^\s*(test|it|describe)\(/i.test(firstLine)) return true;
  if (/^=+$/.test(firstLine) && firstLine.length >= 3 && secondLine !== undefined && secondLine.trim() !== "") return true;
  if (/^-+$/.test(firstLine) && firstLine.length >= 3 && secondLine !== undefined && secondLine.trim() !== "") return true;
  return false;
}

function byteOffsetsForBlocks(content: string): { text: string; startByte: number; endByte: number }[] {
  const blocks: { text: string; startByte: number; endByte: number }[] = [];
  const pattern = /\n\s*\n/g;
  let match: RegExpExecArray | null;
  let charIndex = 0;
  let byteIndex = 0;

  while ((match = pattern.exec(content)) !== null) {
    const blockChars = content.slice(charIndex, match.index);
    if (blockChars.length > 0) {
      const blockBytes = Buffer.byteLength(blockChars, "utf8");
      blocks.push({ text: blockChars, startByte: byteIndex, endByte: byteIndex + blockBytes });
      byteIndex += blockBytes;
    }
    const delimiter = match[0];
    byteIndex += Buffer.byteLength(delimiter, "utf8");
    charIndex = match.index + delimiter.length;
  }

  const trailing = content.slice(charIndex);
  if (trailing.length > 0) {
    blocks.push({ text: trailing, startByte: byteIndex, endByte: byteIndex + Buffer.byteLength(trailing, "utf8") });
  }

  return blocks;
}

function lineWindows(content: string, artifactId: string): OutputSection[] {
  const sections: OutputSection[] = [];
  const segments = content.split("\n");
  const trailingEmpty = content.endsWith("\n") ? 1 : 0;
  const lineCount = segments.length - trailingEmpty;

  const lineStart: number[] = [];
  let byte = 0;
  for (let i = 0; i < lineCount; i++) {
    const segBytes = Buffer.byteLength(segments[i]!, "utf8");
    lineStart[i] = byte;
    byte += segBytes + (i < lineCount - 1 || content.endsWith("\n") ? 1 : 0);
  }

  for (let start = 0; start < lineCount; start += LINE_WINDOW) {
    const end = Math.min(start + LINE_WINDOW, lineCount);
    const startByte = lineStart[start]!;
    const text = segments.slice(start, end).join("\n");
    const endByte = startByte + Buffer.byteLength(text, "utf8");
    sections.push({
      id: `${artifactId}:${sections.length}`,
      artifactId,
      startByte,
      endByte,
      text,
      requires: [],
    });
  }

  return sections;
}

function processBlocks(blocks: { text: string; startByte: number; endByte: number }[], artifactId: string): OutputSection[] {
  const sections: OutputSection[] = [];
  const consumed = new Set<number>();

  for (let i = 0; i < blocks.length; i++) {
    if (consumed.has(i)) continue;
    const block = blocks[i]!;
    const lines = block.text.split("\n");
    const firstLine = lines[0]!;
    const secondLine = lines[1];

    if (!isHeaderLine(firstLine, secondLine)) {
      sections.push({
        id: `${artifactId}:${sections.length}`,
        artifactId,
        startByte: block.startByte,
        endByte: block.endByte,
        text: block.text,
        requires: [],
      });
      continue;
    }

    const headerBytes = Buffer.byteLength(firstLine, "utf8");
    const headerEndByte = block.startByte + headerBytes;
    const headerId = `${artifactId}:${sections.length}`;
    sections.push({
      id: headerId,
      artifactId,
      startByte: block.startByte,
      endByte: headerEndByte,
      text: firstLine,
      requires: [],
    });

    if (lines.length > 1) {
      const childStartByte = headerEndByte + 1;
      const childText = lines.slice(1).join("\n");
      sections.push({
        id: `${artifactId}:${sections.length}`,
        artifactId,
        startByte: childStartByte,
        endByte: block.endByte,
        text: childText,
        requires: [headerId],
      });
    }

    consumed.add(i);

    for (let j = i + 1; j < blocks.length; j++) {
      const next = blocks[j]!;
      if (!/^\s/.test(next.text)) break;
      sections.push({
        id: `${artifactId}:${sections.length}`,
        artifactId,
        startByte: next.startByte,
        endByte: next.endByte,
        text: next.text,
        requires: [headerId],
      });
      consumed.add(j);
    }
  }

  return sections;
}

export function splitIntoSections(artifactId: string, content: string): SectionManifest {
  if (!content) {
    const sections: OutputSection[] = [];
    const catalogHash = hashAction({ schema: SECT_NAMESPACE, artifactId, sections });
    return { catalogHash, entries: Object.freeze(sections) };
  }

  const hasBlankLines = /\n\s*\n/.test(content);
  const blocks = hasBlankLines
    ? byteOffsetsForBlocks(content)
    : [{ text: content, startByte: 0, endByte: Buffer.byteLength(content, "utf8") }];
  const sections = processBlocks(blocks, artifactId);

  const denseFallback = !hasBlankLines && sections.length === 1 && sections[0]!.text === content;
  const finalSections = denseFallback ? lineWindows(content, artifactId) : sections;

  const catalogHash = hashAction({ schema: SECT_NAMESPACE, artifactId, sections: finalSections });
  return { catalogHash, entries: Object.freeze(finalSections) };
}

export function dependencyClosure(manifest: SectionManifest, selectedIds: readonly string[]): string[] {
  const indexById = new Map(manifest.entries.map((s, i) => [s.id, i] as const));
  const reached = new Set<string>();
  const queue: string[] = [];

  for (const id of selectedIds) {
    if (!reached.has(id)) {
      reached.add(id);
      queue.push(id);
    }
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const idx = indexById.get(id);
    if (idx === undefined) continue;
    const section = manifest.entries[idx]!;
    for (const dep of section.requires) {
      if (!reached.has(dep)) {
        reached.add(dep);
        queue.push(dep);
      }
    }
  }

  return manifest.entries.filter((s) => reached.has(s.id)).map((s) => s.id);
}
