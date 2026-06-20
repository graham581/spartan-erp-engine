import fs from 'node:fs';
import path from 'node:path';

/** Field types whose `options` value is a target doctype name (closure deps). */
const CLOSURE_FIELDTYPES = new Set(['Link', 'Table', 'Table MultiSelect']);

/**
 * Returns true when the parsed JSON looks like a real DocType definition.
 * Filters out the ~635 files that are not actual DocType JSONs.
 * @param {object} json
 * @returns {boolean}
 */
function isRealDoctype(json) {
  return json && json.doctype === 'DocType';
}

/**
 * Walk `root` recursively and collect every path that matches
 * the ERPNext convention: `<module>/doctype/<name>/<name>.json`
 * (i.e. sits two dirs below a `doctype` dir and has a `.json` extension).
 * Returns absolute file paths only — the caller decides which are real DocTypes.
 *
 * @param {string} root  erpnext source root
 * @returns {string[]}   absolute JSON file paths
 */
export function listAllDoctypeFiles(root) {
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.json') &&
        // must sit inside a `doctype/<name>/` subtree
        _isInsideDoctypeDir(full)
      ) {
        results.push(full);
      }
    }
  }

  walk(path.resolve(root));
  return results;
}

/**
 * Returns true when `filePath` sits under a `doctype/<name>/` dir
 * (i.e. its parent's parent segment is named `doctype`).
 * @param {string} filePath
 * @returns {boolean}
 */
function _isInsideDoctypeDir(filePath) {
  const parts = filePath.split(path.sep);
  // parts looks like [..., 'doctype', '<name>', '<name>.json']
  return parts.length >= 3 && parts[parts.length - 3] === 'doctype';
}

/**
 * Build a map of `doctypeName → absoluteFilePath` from all real DocType
 * JSON files under `root`.
 * @param {string} root
 * @returns {Map<string, string>}
 */
function _buildIndex(root) {
  const files = listAllDoctypeFiles(root);
  const index = new Map();
  for (const f of files) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    if (isRealDoctype(json) && typeof json.name === 'string') {
      index.set(json.name, f);
    }
  }
  return index;
}

/**
 * Extract the direct doctype dependencies from a parsed DocType JSON.
 * Only `Link`, `Table`, and `Table MultiSelect` fields contribute a dep
 * (their `options` is the target doctype name).
 * `Dynamic Link` is explicitly excluded — its `options` is a sibling field
 * name, not a doctype name.
 *
 * @param {object} json  parsed DocType JSON
 * @returns {string[]}   doctype names this type depends on
 */
function _depsOf(json) {
  const deps = [];
  for (const field of json.fields ?? []) {
    if (
      CLOSURE_FIELDTYPES.has(field.fieldtype) &&
      typeof field.options === 'string' &&
      field.options.trim() !== ''
    ) {
      deps.push(field.options.trim());
    }
  }
  return deps;
}

/**
 * Compute the set of doctype NAMES to generate.
 *
 * When `opts.noClosure` is falsy (the default), performs a BFS starting
 * from `seeds` and follows every `Link` / `Table` / `Table MultiSelect`
 * target transitively — returning `seeds ∪ all transitive targets`.
 *
 * When `opts.noClosure === true`, returns exactly `seeds` — but THROWS
 * (fail-AT-GENERATE) if any seed's `Link`/`Table`/`Table MultiSelect` field
 * points to a doctype outside the seed set, naming the first missing target.
 * This is the D1-1 guard rail: you must either close the graph or opt in to
 * dangling references explicitly.
 *
 * @param {string[]} seeds  doctype NAMES to start from
 * @param {string}   root   erpnext source root
 * @param {{ noClosure?: boolean }} [opts]
 * @returns {string[]}      doctype names to generate
 */
export function closureOver(seeds, root, opts) {
  const noClosure = opts?.noClosure === true;
  const index = _buildIndex(root);

  if (noClosure) {
    // No closure — just validate that seeds have no outside deps.
    const seedSet = new Set(seeds);
    for (const name of seeds) {
      const file = index.get(name);
      if (!file) continue; // unknown seed — let downstream handle
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const dep of _depsOf(json)) {
        if (!seedSet.has(dep)) {
          throw new Error(
            `closureOver: noClosure=true but seed "${name}" has a Link/Table dep on ` +
              `"${dep}" which is outside the seed set. Either add "${dep}" to seeds ` +
              `or enable closure (remove noClosure).`
          );
        }
      }
    }
    return [...seeds];
  }

  // Closure ON — BFS.
  const visited = new Set(seeds);
  const queue = [...seeds];

  while (queue.length > 0) {
    const current = queue.shift();
    const file = index.get(current);
    if (!file) continue; // doctype not found in this root — skip
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const dep of _depsOf(json)) {
      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }

  return [...visited];
}
