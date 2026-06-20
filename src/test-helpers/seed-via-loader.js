/**
 * seedViaLoader — test helper that routes through the real Installer + MetaLoader
 * pipeline so snake→camel (C4), 0/1→bool (C5), parent→doctype (C5), and
 * childTables[].table (M4) are all exercised by the actual production code
 * (NOT a re-implemented registerDoctype, which would skip the loader — M3).
 *
 * Usage:
 *   const store = await seedViaLoader([CustomerDef, GadgetDef]);
 *   // store now has meta rows persisted AND every def primed via the real loader.
 */

import { MemoryStore } from '../runtime/memory-store.js';
import { registerBootMeta } from '../meta/boot-meta.js';
import { syncDoctype } from '../meta/installer.js';
import { load } from '../meta/loader.js';

/**
 * Seed doctypes into a MemoryStore via the real Installer + MetaLoader pipeline.
 * @param {Array<import('../meta/registry.js').DocMeta>} defs  install in dependency order (Link/Table targets first)
 * @param {MemoryStore} [store]
 * @returns {Promise<MemoryStore>}
 */
export async function seedViaLoader(defs, store = new MemoryStore()) {
  registerBootMeta(); // pin the 6 boot meta-doctypes (idempotent)
  for (const def of defs) await syncDoctype(def, store); // upsert tabDocType/tabDocField/tabDocPerm rows
  for (const def of defs) await load(def.doctype, store); // hydrate through the real loader
  return store;
}
