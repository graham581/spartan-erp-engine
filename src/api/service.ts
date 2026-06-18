import type { DataStore } from '../runtime/store';
import { SupabaseStore } from '../runtime/supabaseStore';
import { newDoc, loadDoc, SubmittableDocument, type AnyDoc } from '../runtime/document';
import { registerControllers } from '../controllers/index';

// Wire controllers into the registry on module load (idempotent).
registerControllers();

let prodStore: SupabaseStore | null = null;

/** Lazily build the Supabase-backed store from env (only when no store is injected). */
function getStore(): DataStore {
  if (!prodStore) prodStore = SupabaseStore.fromEnv();
  return prodStore;
}

export async function createSalesOrder(
  payload: Record<string, unknown>,
  store: DataStore = getStore(),
): Promise<AnyDoc> {
  const doc = newDoc('Sales Order', { ...payload }, store);
  await doc.insert();
  return doc.doc;
}

export async function getSalesOrder(name: string, store: DataStore = getStore()): Promise<AnyDoc> {
  const doc = await loadDoc('Sales Order', name, store);
  return doc.doc;
}

export async function transitionSalesOrder(
  name: string,
  action: 'submit' | 'cancel',
  store: DataStore = getStore(),
): Promise<AnyDoc> {
  const doc = await loadDoc('Sales Order', name, store);
  if (!(doc instanceof SubmittableDocument)) throw new Error(`${name} is not submittable`);
  if (action === 'submit') await doc.submit();
  else if (action === 'cancel') await doc.cancel();
  else throw new Error(`Unknown action: ${action}`);
  return doc.doc;
}
