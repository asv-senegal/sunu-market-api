import { fileURLToPath } from 'node:url';
// Journal d'audit sans l'extension pgcrypto : migrations, UUID, empreintes chaînées, détection des falsifications.
// Base dédiée : DATABASE_URL de .env.test (vidée à chaque lancement).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const { db } = await import('../src/db.js');
const { audit } = await import('../src/lib/audit.js');
const { verifyAuditChain } = await import('../src/lib/audit-verify.js');

before(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  execSync('node scripts/migrate.js', { cwd: fileURLToPath(new URL('..', import.meta.url)), env: process.env, stdio: 'ignore' });
});
after(() => db.end());

// Calcul indépendant, entièrement en JavaScript, à partir des colonnes (seul l'horodatage est mis en forme par PostgreSQL,
// pour garder les microsecondes) : doit donner la même empreinte que le déclencheur.
const jsHash = (r) => crypto.createHash('sha256').update(
  `${r.prev_hash ?? ''}|${r.id}|${r.actor_id ?? ''}|${r.action}|${r.target ?? ''}|${r.details_text}|${r.ts}`, 'utf8').digest('hex');
const rows = () => db.many(`SELECT id, actor_id, action, target, details::text details_text, prev_hash, hash,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') ts FROM audit_log ORDER BY id`);
const tamper = async (sql, params) => {
  await db.query('ALTER TABLE audit_log DISABLE TRIGGER audit_append_only');
  try { await db.query(sql, params); } finally { await db.query('ALTER TABLE audit_log ENABLE TRIGGER audit_append_only'); }
};

test('aucune dépendance à pgcrypto, UUID natifs', async () => {
  const ext = await db.one(`SELECT count(*)::int n FROM pg_extension WHERE extname = 'pgcrypto'`);
  assert.equal(ext.n, 0, 'pgcrypto ne doit pas être installée par les migrations');
  const fn = await db.one(`SELECT prosrc FROM pg_proc WHERE proname = 'audit_chain'`);
  assert.doesNotMatch(fn.prosrc, /digest\(/, 'le déclencheur ne doit plus utiliser digest()');
  const u = await db.one(`INSERT INTO users (first_name, last_name, phone, password_hash, quarter, consent_at) VALUES ('Test','UUID','+221700009999','x','Plateau', now()) RETURNING id`);
  assert.match(u.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('empreintes chaînées : textes accentués, guillemets, NULL', async () => {
  const actor = (await db.one(`SELECT id FROM users LIMIT 1`)).id;
  await audit(null, 'system.start', null, {});
  await audit(actor, 'payment.paid', 'payment:1', { ref: 'AB-1', note: 'Crédits reçus — « test » é à ç', total: 2500 });
  await audit(actor, 'listing.update', 'listing:2', { title: 'Sac "cuir" \\ fait main 👜', tags: ['wax', 'bazin'], vide: null });
  await audit(null, 'export.audit', 'audit_log', { rows: 3, nested: { a: [1, 2.5, true] } });

  const all = await rows();
  assert.equal(all.length, 4);
  assert.equal(all[0].prev_hash, null, 'la première ligne n’a pas de prédécesseur');
  for (let i = 0; i < all.length; i++) {
    assert.equal(all[i].hash, jsHash(all[i]), `empreinte de la ligne ${all[i].id}`);
    if (i > 0) assert.equal(all[i].prev_hash, all[i - 1].hash, `chaînage de la ligne ${all[i].id}`);
    assert.match(all[i].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/, 'horodatage à la microseconde');
  }
  assert.deepEqual(await verifyAuditChain(), { total: 4, broken: 0, first_broken: null });
  // Petits lots : le chaînage se poursuit d'un lot à l'autre
  assert.deepEqual(await verifyAuditChain({ batchSize: 1 }), { total: 4, broken: 0, first_broken: null });
});

test('falsifications détectées', async () => {
  const [, second, third] = await rows();
  await tamper('UPDATE audit_log SET details = $2 WHERE id = $1', [second.id, { ref: 'AB-1', total: 25 }]);
  let v = await verifyAuditChain();
  assert.equal(v.broken, 1); assert.equal(v.first_broken, Number(second.id));
  await tamper('UPDATE audit_log SET details = $2::jsonb WHERE id = $1', [second.id, second.details_text]);
  assert.deepEqual(await verifyAuditChain(), { total: 4, broken: 0, first_broken: null }, 'contenu d’origine restauré');

  await tamper('UPDATE audit_log SET prev_hash = $2 WHERE id = $1', [third.id, 'f'.repeat(64)]);
  v = await verifyAuditChain({ batchSize: 2 });
  assert.equal(v.first_broken, Number(third.id), 'maillon de chaîne modifié');
  await tamper('UPDATE audit_log SET prev_hash = $2 WHERE id = $1', [third.id, third.prev_hash]);

  await tamper('UPDATE audit_log SET created_at = created_at + interval \'1 microsecond\' WHERE id = $1', [third.id]);
  v = await verifyAuditChain();
  assert.equal(v.first_broken, Number(third.id), 'une microseconde de différence suffit');
});
