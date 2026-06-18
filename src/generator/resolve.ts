import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { slugify } from './util';

/**
 * Find a DocType's JSON file. Checks our synthetic dir first (for framework
 * doctypes like Currency that aren't in the erpnext app), then the standard
 * ERPNext layout `<root>/<module>/doctype/<slug>/<slug>.json`, then a
 * recursive fallback for doctypes nested deeper (e.g. regional).
 */
export function resolveDocTypePath(
  name: string,
  erpnextRoot: string,
  syntheticDir: string,
): string | null {
  const slug = slugify(name);

  const synthetic = join(syntheticDir, `${slug}.json`);
  if (existsSync(synthetic)) return synthetic;

  let modules: string[] = [];
  try {
    modules = readdirSync(erpnextRoot);
  } catch {
    return null;
  }
  for (const mod of modules) {
    const p = join(erpnextRoot, mod, 'doctype', slug, `${slug}.json`);
    if (existsSync(p)) return p;
  }

  return recursiveFind(erpnextRoot, slug);
}

function recursiveFind(dir: string, slug: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const candidate = join(full, `${slug}.json`);
      if (entry === slug && existsSync(candidate)) return candidate;
      const found = recursiveFind(full, slug);
      if (found) return found;
    }
  }
  return null;
}
