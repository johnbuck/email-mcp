import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * North Star regression guard for the public fork.
 *
 * These rules are quoted from the operator canon (CLAUDE.md):
 *   - secrets-never-in-repo   — no credential material may be committed.
 *   - public-repo-no-topology — no internal homelab topology may land in a
 *     public repo (`.lan` hosts, private IPs, secret-manager references, or
 *     internal identity names).
 *
 * The fork ships only generic mail code, so this currently PASSES; it exists so
 * that if a builder pastes homelab specifics or a credential into shipped
 * source while adding attachment support, this test goes red.
 *
 * Scope: shipped source only (excludes *.test.ts and __integration__ — those
 * are authored here and legitimately contain example/private IPs for SSRF
 * tests). Patterns are generic shapes; no specific homelab identifier is
 * embedded in this file (the internal identity name is assembled at runtime).
 */

// The internal machine-identity name — assembled so the literal never appears
// in the committed public fork.
const INTERNAL_IDENTITY = ['agent', 'architect'].join('-');

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'PEM private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'internal .lan hostname', re: /\b[a-z0-9][a-z0-9-]*\.lan\b/i },
  {
    name: 'RFC1918 private IPv4 literal',
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
  },
  { name: 'secret-manager (infisical) reference', re: /infisical/i },
  { name: 'hardcoded mail-password assignment', re: /EMAIL_PASSWORD\s*[:=]\s*['"][^'"]+['"]/ },
  { name: 'internal identity name', re: new RegExp(INTERNAL_IDENTITY) },
];

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));

async function shippedSourceFiles(): Promise<string[]> {
  const entries = await readdir(SRC_DIR, { recursive: true, withFileTypes: true });
  return entries
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => path.join(d.parentPath, d.name))
    .filter(
      (p) =>
        !p.endsWith('.test.ts') &&
        !p.includes(`${path.sep}__integration__${path.sep}`) &&
        !p.endsWith('.d.ts'),
    );
}

describe('repo hygiene (North Star)', () => {
  // spec: north-star public-repo-no-topology / secrets-never-in-repo
  it('shipped source contains no secrets or homelab topology', async () => {
    const files = await shippedSourceFiles();
    const violations: string[] = [];

    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      const content = await readFile(file, 'utf-8');
      for (const { name, re } of FORBIDDEN) {
        const match = re.exec(content);
        if (match) {
          violations.push(`${path.relative(SRC_DIR, file)}: ${name} (matched "${match[0]}")`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
