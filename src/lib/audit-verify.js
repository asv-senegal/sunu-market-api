// Contrôle d'intégrité du journal d'audit, sans l'extension pgcrypto.
// PostgreSQL fournit, pour chaque ligne, les octets exacts hachés par le déclencheur audit_chain()
// (mêmes champs, même ordre, mêmes séparateurs, même traitement des NULL, même sérialisation JSON,
// horodatage UTC au format YYYY-MM-DD"T"HH24:MI:SS.US avec 6 décimales, encodage de la base).
// Node recalcule le SHA-256 de ces octets : aucune conversion de date en JavaScript, aucune perte de précision.
// Une ligne est incohérente si son empreinte ne correspond pas à son contenu, ou si prev_hash ne reprend pas
// l'empreinte enregistrée de la ligne précédente (la première ligne doit avoir prev_hash vide).
import crypto from 'node:crypto';
import { db } from '../db.js';

const CANONICAL = `convert_to(coalesce(prev_hash, '') || '|' || id || '|' || coalesce(actor_id::text, '') || '|' || action || '|' || coalesce(target, '')
  || '|' || details::text || '|' || to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), getdatabaseencoding())`;

export async function verifyAuditChain({ batchSize = 2000 } = {}) {
  let total = 0, broken = 0, firstBroken = null;
  let lastId = 0;            // pagination par identifiant croissant
  let previousHash = null;   // empreinte enregistrée de la ligne précédente (lag(hash))
  for (;;) {
    const rows = await db.many(
      `SELECT id, hash, prev_hash, ${CANONICAL} AS canonical FROM audit_log WHERE id > $1 ORDER BY id LIMIT $2`,
      [lastId, batchSize]);
    for (const r of rows) {
      const recomputed = crypto.createHash('sha256').update(r.canonical).digest('hex');
      const ok = r.hash === recomputed && (r.prev_hash ?? null) === previousHash;
      total++;
      if (!ok) { broken++; if (firstBroken === null) firstBroken = Number(r.id); }
      previousHash = r.hash ?? null;
      lastId = r.id;
    }
    if (rows.length < batchSize) break;
  }
  return { total, broken, first_broken: firstBroken };
}
