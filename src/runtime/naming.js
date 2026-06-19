import { randomUUID } from 'node:crypto';

/**
 * Resolve a document name from meta.autoname.
 *   'field:<name>'  -> the value of that field (e.g. name a Customer by its code)
 *   '<PREFIX>.####' -> naming series: literal prefix + zero-padded atomic counter
 *   'hash' / unset  -> table-prefixed short uuid
 * @param {import('../meta/registry.js').DocMeta} meta
 * @param {Record<string, any>} doc
 * @param {import('./store.js').Store} store
 * @returns {Promise<string>}
 */
export async function resolveName(meta, doc, store) {
  const rule = meta.autoname || 'hash';
  if (rule.startsWith('field:')) {
    const v = doc[rule.slice('field:'.length)];
    if (v !== undefined && v !== null && v !== '') return String(v);
    // empty naming field -> fall through to hash
  }
  if (rule.includes('#')) return nextSeries(rule, store);
  return `${meta.table}-${randomUUID().slice(0, 8)}`;
}

/**
 * Naming series: a prefix with a run of '#' placeholders, e.g.
 * 'SO-.#####' -> 'SO-00001'. The counter is stored per-prefix in `tab_series`
 * and incremented by +1.
 *
 * NOTE on atomicity: MemoryStore is single-threaded so read-inc-write is safe.
 * SupabaseStore will back this with an atomic RPC (`UPDATE tab_series
 * SET current = current + 1 WHERE name = $1 RETURNING current`) so concurrent
 * Vercel invocations can't collide — that's the Phase-1 "kills the max+1 race"
 * fix, applied at the store layer without changing this contract.
 * @param {string} pattern
 * @param {import('./store.js').Store} store
 * @returns {Promise<string>}
 */
export async function nextSeries(pattern, store) {
  const hashes = pattern.match(/#+/);
  const width = hashes ? hashes[0].length : 5;
  const prefix = pattern.replace(/\.?#+/, '');
  const key = prefix || 'NS';
  const row = await store.get('tab_series', key);
  const next = (row ? Number(row.current) : 0) + 1;
  if (row) await store.update('tab_series', key, { name: key, current: next });
  else await store.insert('tab_series', { name: key, current: next });
  return prefix + String(next).padStart(width, '0');
}
