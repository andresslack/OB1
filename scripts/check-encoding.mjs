#!/usr/bin/env node
/**
 * Fail the build when a text file contains CP1252-mojibake.
 *
 * Mojibake gets into a repo when a tool reads UTF-8 bytes as Windows-1252 and
 * writes the result back out as UTF-8. Each such pass mangles every non-ASCII
 * character one level deeper: "—" becomes "â€”", then
 * "Ã¢â‚¬â€", and so on (encoding-check:allow). The classic
 * source on Windows is PowerShell 5.1, whose Get-Content defaults to the ANSI
 * codepage while Out-File writes UTF-8 — the two disagree, so piping one into
 * the other corrupts the file. (Get-Content | Set-Content is lossless by
 * accident: it writes ANSI, undoing the misread.)
 *
 * Detection is by attempted repair rather than by pattern match, which keeps
 * false positives near zero: a line is only reported when mapping it back
 * through CP1252 yields valid UTF-8 with no U+FFFD AND re-applying the
 * corruption reproduces the line exactly. Ordinary accented text fails those
 * checks and is left alone.
 *
 * Usage:  node scripts/check-encoding.mjs [rootDir]
 * Exit:   0 clean, 1 mojibake found.
 *
 * To intentionally include a mojibake example (e.g. documentation about this
 * very bug), put the marker below anywhere on the line.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';

const IGNORE_MARKER = 'encoding-check:allow';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', 'out', 'vendor', '.vercel', 'coverage',
]);

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.md', '.mdx',
  '.yml', '.yaml', '.toml', '.html', '.css', '.scss', '.txt', '.sql', '.sh', '.env',
]);

// Code points for CP1252 bytes 0x80-0x9F. Everything else in 0x00-0xFF maps 1:1.
const CP1252_HIGH = [
  0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F, 0x90, 0x2018, 0x2019, 0x201C,
  0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D,
  0x017E, 0x0178,
];
const toByte = new Map(CP1252_HIGH.map((cp, i) => [cp, 0x80 + i]));
const fromByte = new Map(CP1252_HIGH.map((cp, i) => [0x80 + i, cp]));

/** Encode a string as CP1252 bytes, or null if any char has no CP1252 byte. */
function toCp1252(text) {
  const bytes = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (toByte.has(cp)) bytes.push(toByte.get(cp));
    else if (cp < 0x100) bytes.push(cp);
    else return null;
  }
  return Buffer.from(bytes);
}

/** Re-apply the corruption: UTF-8 bytes reinterpreted as CP1252. */
const corrupt = (text) =>
  [...Buffer.from(text, 'utf8')]
    .map((b) => String.fromCodePoint(fromByte.get(b) ?? b))
    .join('');

/** One verified un-corruption pass, or null if this text isn't mojibake. */
function repairOnce(text) {
  const bytes = toCp1252(text);
  if (!bytes) return null;
  const fixed = bytes.toString('utf8');
  if (fixed === text) return null;
  if (fixed.includes('�')) return null;
  if (corrupt(fixed) !== text) return null;
  return fixed;
}

/** Repair to a fixed point. depth = how many CP1252 round-trips the text took. */
function repairFully(text) {
  let current = text;
  let depth = 0;
  while (depth < 6) {
    const next = repairOnce(current);
    if (next === null) break;
    current = next;
    depth += 1;
  }
  return { fixed: current, depth };
}

// Cheap pre-filter: mojibake always starts with one of these lead characters.
const SUSPECT = /[ÃâÂ][-ÿ -⇿]/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (entry.isFile() && TEXT_EXT.has(extname(entry.name).toLowerCase())) {
      yield full;
    }
  }
}

const root = process.argv[2] ?? process.cwd();
const findings = [];

for (const file of walk(root)) {
  if (statSync(file).size > 5 * 1024 * 1024) continue;
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (!SUSPECT.test(content)) continue;

  content.split(/\r?\n/).forEach((line, i) => {
    if (!SUSPECT.test(line)) return;
    if (line.includes(IGNORE_MARKER)) return;
    const { fixed, depth } = repairFully(line);
    if (depth === 0) return; // suspicious shape, but not decodable mojibake
    findings.push({
      file: relative(root, file).split(sep).join('/'),
      line: i + 1,
      depth,
      before: line.trim(),
      after: fixed.trim(),
    });
  });
}

if (findings.length === 0) {
  console.log('encoding check: no mojibake found');
  process.exit(0);
}

console.error(
  `\nencoding check FAILED: ${findings.length} mojibake line(s) in ` +
    `${new Set(findings.map((f) => f.file)).size} file(s)\n`,
);
for (const f of findings) {
  console.error(`${f.file}:${f.line}  (${f.depth} CP1252 round-trip${f.depth > 1 ? 's' : ''})`);
  console.error(`   found:    ${f.before.slice(0, 140)}`);
  console.error(`   expected: ${f.after.slice(0, 140)}\n`);
}
console.error(
  'A tool wrote these files reading UTF-8 as Windows-1252.\n' +
    'On Windows, avoid `Get-Content | Out-File` under PowerShell 5.1 — its read\n' +
    'and write defaults disagree. PowerShell 7+ defaults to UTF-8 throughout.\n' +
    `If a line is mojibake on purpose, add the marker "${IGNORE_MARKER}" to it.\n`,
);
process.exit(1);
