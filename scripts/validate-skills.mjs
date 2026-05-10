#!/usr/bin/env node
/**
 * Validate SKILL.md frontmatter against what the `skills` CLI requires.
 *
 * Mirrors the parsing logic in https://www.npmjs.com/package/skills
 * (parseSkillMd in dist/cli.mjs):
 *   - Frontmatter delimited by `---` lines
 *   - YAML inside parses cleanly
 *   - `name` is a non-empty string
 *   - `description` is a non-empty string
 *
 * Zero runtime dependencies. Uses a minimal YAML parser scoped to the
 * shapes SKILL.md frontmatter actually contains (top-level scalars and
 * a single nested `metadata` block).
 *
 * Usage:
 *   node scripts/validate-skills.mjs                # validates skills/(any)/SKILL.md
 *   node scripts/validate-skills.mjs path/SKILL.md  # validates explicit paths
 *
 * Exits non-zero on any failure (suitable for pre-commit and CI).
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseFrontmatter(text) {
  const data = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) { i++; continue; }
    const topMatch = raw.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!topMatch) {
      return { ok: false, error: `Line ${i + 1} is not a valid \`key: value\` pair: ${JSON.stringify(raw)}` };
    }
    const key = topMatch[1];
    const rest = topMatch[2];
    if (rest === '' || rest === '|' || rest === '>') {
      const childLines = [];
      i++;
      while (i < lines.length) {
        const peek = lines[i];
        if (/^\s+/.test(peek) || peek === '') {
          childLines.push(peek);
          i++;
        } else {
          break;
        }
      }
      if (rest === '|' || rest === '>') {
        const dedented = childLines.map(l => l.replace(/^\s\s/, '')).join('\n').trimEnd();
        data[key] = dedented;
      } else {
        const nested = {};
        for (const child of childLines) {
          if (!child.trim() || child.trim().startsWith('#')) continue;
          const m = child.match(/^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
          if (!m) {
            return { ok: false, error: `Nested line under \`${key}\` is not \`key: value\`: ${JSON.stringify(child)}` };
          }
          nested[m[1]] = unquote(m[2]);
        }
        data[key] = nested;
      }
    } else {
      data[key] = unquote(rest);
      i++;
    }
  }
  return { ok: true, data };
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

async function findSkillFiles() {
  const skillsDir = join(REPO_ROOT, 'skills');
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = join(skillsDir, e.name, 'SKILL.md');
    try {
      if ((await stat(candidate)).isFile()) found.push(candidate);
    } catch {}
  }
  return found;
}

function validate(content) {
  const errors = [];
  const m = content.match(FRONTMATTER_RE);
  if (!m) {
    errors.push('No YAML frontmatter block found. File must start with --- on its own line, then YAML, then --- on its own line.');
    return { ok: false, errors };
  }
  if (/^\s*##\s+name\s*:/m.test(m[1])) {
    errors.push('Frontmatter contains `## name:` (markdown heading syntax). YAML keys must NOT be prefixed with `#` -- write `name: ai-value-advisor`, not `## name: ai-value-advisor`.');
  }
  const parsed = parseFrontmatter(m[1]);
  if (!parsed.ok) {
    errors.push(`YAML parse error: ${parsed.error}`);
    return { ok: false, errors };
  }
  const data = parsed.data;
  if (!data.name) errors.push('Missing required field: `name`.');
  else if (typeof data.name !== 'string') errors.push(`Field \`name\` must be a string, got ${typeof data.name}.`);
  else if (!data.name.trim()) errors.push('Field `name` is empty.');
  if (!data.description) errors.push('Missing required field: `description`.');
  else if (typeof data.description !== 'string') errors.push(`Field \`description\` must be a string, got ${typeof data.description}.`);
  else if (!data.description.trim()) errors.push('Field `description` is empty.');
  if (errors.length) return { ok: false, errors };
  return { ok: true, name: data.name, descriptionLength: data.description.length };
}

async function main() {
  const argv = process.argv.slice(2);
  const targets = argv.length ? argv : await findSkillFiles();
  if (!targets.length) {
    console.log('No SKILL.md files to validate.');
    process.exit(0);
  }
  let failed = 0;
  for (const target of targets) {
    let content;
    try {
      content = await readFile(target, 'utf-8');
    } catch (e) {
      failed++;
      console.error(`\u2717 ${target}\n  - Could not read file: ${e.message}`);
      continue;
    }
    const result = validate(content);
    const display = relative(REPO_ROOT, target) || target;
    if (result.ok) {
      console.log(`\u2713 ${display}  (name=${result.name}, description=${result.descriptionLength} chars)`);
    } else {
      failed++;
      console.error(`\u2717 ${display}`);
      for (const err of result.errors) console.error(`  - ${err}`);
    }
  }
  if (failed) {
    console.error(`\n${failed} file(s) failed validation.`);
    process.exit(1);
  }
  console.log(`\n${targets.length} file(s) OK.`);
}

main().catch(err => {
  console.error('Validator crashed:', err);
  process.exit(2);
});
