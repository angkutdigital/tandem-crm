#!/usr/bin/env node
// Copies each reducer `case "<event type>":` block verbatim out of the four
// reducer files into a JSON file the marketing site's live demo reads. No
// formatting, no rewriting: the only transformations are removing the
// indentation shared by the whole block and trimming trailing blank/comment
// lines that belong to the NEXT case. Each snippet records its file, line
// range and a GitHub link pinned to the commit the lines were read at.
//
// Usage: node scripts/extract-demo-snippets.mjs [--out path/to/demo-snippets.json]

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_URL = "https://github.com/angkutdigital/tandem-crm";
const FILES = ["src/domain.ts", "src/trail.ts", "src/belay.ts", "src/ascent.ts"];

const outArg = process.argv.indexOf("--out");
const out = resolve(outArg > -1 ? process.argv[outArg + 1] : resolve(root, "../tandem-site/public/demo-snippets.json"));

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
// Line links are only truthful if the working files match the pinned commit.
if (git("status", "--porcelain", "--", ...FILES) !== "") {
  throw new Error(`refusing to run: ${FILES.join(", ")} have uncommitted changes, so line numbers would not match commit ${commit}`);
}

const indentOf = (line) => line.match(/^\s*/)[0].length;
const snippets = {};

for (const file of FILES) {
  const lines = readFileSync(resolve(root, file), "utf8").split("\n");
  const switches = lines.flatMap((l, i) => (/^\s*switch \(event\.type\) \{\s*$/.test(l) ? [i] : []));
  if (switches.length !== 1) throw new Error(`${file}: expected exactly one "switch (event.type)", found ${switches.length}`);
  const start = switches[0];
  const caseIndent = indentOf(lines[start + 1]);

  // Case boundaries at the switch's own case indent, until the switch closes.
  const marks = [];
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== "" && indentOf(l) < caseIndent) { end = i; break; }
    if (indentOf(l) !== caseIndent) continue;
    const m = l.match(/^\s*case "([^"]+)":/);
    if (m) marks.push({ type: m[1], line: i });
    else if (/^\s*default:/.test(l)) marks.push({ type: null, line: i });
  }
  if (end === -1) throw new Error(`${file}: switch never closed`);

  marks.forEach((mark, k) => {
    if (mark.type === null) return;
    const next = k + 1 < marks.length ? marks[k + 1].line : end;
    let last = next - 1;
    // Drop blank lines and comment lines that sit above the next case.
    while (last > mark.line && (lines[last].trim() === "" || lines[last].trim().startsWith("//"))) last--;
    const block = lines.slice(mark.line, last + 1);
    const strip = Math.min(...block.filter((l) => l.trim() !== "").map(indentOf));
    if (snippets[mark.type]) throw new Error(`duplicate case ${mark.type}`);
    snippets[mark.type] = {
      file,
      startLine: mark.line + 1,
      endLine: last + 1,
      url: `${REPO_URL}/blob/${commit}/${file}#L${mark.line + 1}-L${last + 1}`,
      code: block.map((l) => l.slice(strip)).join("\n"),
    };
  });
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ repo: REPO_URL, commit, snippets }, null, 2) + "\n");
console.log(`wrote ${Object.keys(snippets).length} snippets at ${commit.slice(0, 7)} -> ${out}`);
