import { db } from '../db.js';
// Paramètres de la plateforme (table settings), mis en cache 15 secondes
let cache = { at: 0, map: {} };
export async function settings() {
  if (Date.now() - cache.at < 15_000) return cache.map;
  const rows = await db.many('SELECT key, value FROM settings');
  cache = { at: Date.now(), map: Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  return cache.map;
}
export const setting = async (key) => (await settings())[key];
export const clearSettingsCache = () => { cache.at = 0; };
