import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOTS = ["src", "test"];

function listSourceFiles(directory: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "fixtures" || entry === "node_modules") {
        continue;
      }
      results.push(...listSourceFiles(full));
    } else if (full.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

function findComments(file: string): number[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const positions = new Set<number>();
  const visit = (node: ts.Node): void => {
    for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
      positions.add(range.pos);
    }
    for (const range of ts.getTrailingCommentRanges(text, node.getEnd()) ?? []) {
      positions.add(range.pos);
    }
    for (const child of node.getChildren(source)) {
      visit(child);
    }
  };
  visit(source);
  return [...positions].sort((a, b) => a - b).map((position) => text.slice(0, position).split("\n").length);
}

describe("source style", () => {
  it("contains no comments", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of listSourceFiles(root)) {
        const lines = findComments(file);
        if (lines.length > 0) {
          offenders.push(`${file}:${lines.join(",")}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
