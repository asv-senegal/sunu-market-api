import { fileURLToPath } from 'node:url';
// Test de bout en bout du parcours principal. Base dédiée : DATABASE_URL de .env.test (vidée à chaque lancement).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import request from 'supertest';

process.env.STORAGE_DIR = '/tmp/sunu-test-storage';
const { db } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const app = createApp();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  execSync('node scripts/migrate.js && node scripts/seed.js', { cwd: fileURLToPath(new URL('..', import.meta.url)), env: process.env, stdio: 'ignore' });
});
after(() => db.end());

const reg = async (phone, first) => {
  const otp = await request(app).post('/api/auth/otp').send({ phone, purpose: 'register' });
  assert.equal(otp.status, 200, JSON.stringify(otp.body));
  const wrong = await request(app).post('/api/auth/register').send({ firstName: first, lastName: 'Test', phone, password: 'motdepasse1', consent: true, code: '000000' === otp.body.devCode ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  const r = await request(app).post('/api/auth/register').send({ firstName: first, lastName: 'Test', phone, password: 'motdepasse1', quarter: 'Médina', consent: true, code: otp.body.devCode });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.token;
};
const as = (tok) => ({ get: (u) => request(app).get(u).set('Authorization', `Bearer ${tok}`), post: (u) => request(app).post(u).set('Authorization', `Bearer ${tok}`), patch: (u) => request(app).patch(u).set('Authorization', `Bearer ${tok}`) });

test('parcours complet', async () => {
  // Catalogue
  const cats = await request(app).get('/api/categories');
  assert.equal(cats.body.items.length, 12);
  assert.equal(cats.body.items.reduce((a, c) => a + c.subs.length, 0), 93);

  // Inscription : numéro invalide refusé
  const badPhone = await request(app).post('/api/auth/register').send({ firstName: 'Aa', lastName: 'Bb', phone: '12345', password: 'motdepasse1', consent: true });
  assert.equal(badPhone.status, 400);

  const seller = await reg('77 000 00 21', 'Vendeuse');
  const buyer = await reg('+221 76 000 00 22', 'Acheteur');

  // Compte non vérifié : aucune action possible
  const blocked = await as(seller).post('/api/me/shop').send({ name: 'Ma Boutique Test' });
  assert.equal(blocked.status, 403); assert.equal(blocked.body.code, 'not_verified');

  // Vérification obligatoire : document + selfie
  for (const tok of [seller, buyer]) {
    const v = await as(tok).post('/api/me/verification').field('docType', 'cni')
      .attach('document', PNG, { filename: 'doc.png', contentType: 'image/png' }).attach('selfie', PNG, { filename: 's.png', contentType: 'image/png' });
    assert.equal(v.status, 201, JSON.stringify(v.body));
  }
  // Administrateur
  await db.query(`INSERT INTO users (first_name,last_name,phone,password_hash,role,verification_status,consent_at)
    VALUES ('Admin','Test','+221700000099','x','admin','verified',now())`);
  const adminId = (await db.one(`SELECT id FROM users WHERE phone = '+221700000099'`)).id;
  const { signToken } = await import('../src/lib/auth.js');
  const admin = signToken({ id: adminId });
  const pend = await as(admin).get('/api/admin/verifications');
  assert.equal(pend.body.items.length, 2);
  const file = await as(admin).get(`/api/admin/verifications/${pend.body.items[0].id}/file/document`);
  assert.equal(file.status, 200);
  for (const v of pend.body.items) assert.equal((await as(admin).post(`/api/admin/verifications/${v.id}/decision`).send({ decision: 'approved' })).status, 200);
  // Images purgées après décision
  assert.equal((await db.one('SELECT count(*)::int n FROM verifications WHERE doc_file IS NOT NULL')).n, 0);
  assert.equal((await as(admin).get(`/api/admin/verifications/${pend.body.items[0].id}/file/document`)).status, 404);

  // Boutique + essai de 14 jours
  const shop = await as(seller).post('/api/me/shop').send({ name: 'Boutique Test Médina', quarter: 'Médina' });
  assert.equal(shop.status, 201);
  const dash = await as(seller).get('/api/me/shop');
  assert.equal(dash.body.subscription.kind, 'trial');
  const days = (new Date(dash.body.subscription.ends_at) - Date.now()) / 864e5;
  assert.ok(days > 13.9 && days <= 14);
  assert.equal((await as(seller).get('/api/me')).body.credits, 500, 'crédits SM-IA offerts pendant l’essai');

  // Annonce
  const sub = cats.body.items.find((c) => c.slug === 'femmes').subs.find((s) => s.slug === 'beaute');
  const shopsCat = cats.body.items.find((c) => c.slug === 'boutiques');
  const refused = await as(seller).post('/api/listings').field('subcategoryId', shopsCat.subs[0].id).field('title', 'Article test').field('priceFcfa', 1000)
    .field('condition', 'new').field('payMethods', 'wave').attach('photos', PNG, { filename: 'p.png', contentType: 'image/png' });
  assert.equal(refused.status, 400, 'la catégorie Boutiques ne reçoit pas d’annonces');
  const lst = await as(seller).post('/api/listings').field('subcategoryId', sub.id).field('title', 'Beurre de karité test').field('description', 'Pot de 250 g')
    .field('priceFcfa', 3500).field('condition', 'new').field('stock', 2).field('payMethods', 'wave').field('payMethods', 'cash')
    .attach('photos', PNG, { filename: 'p.png', contentType: 'image/png' });
  assert.equal(lst.status, 201, JSON.stringify(lst.body));
  const id = lst.body.id;

  // Recherche publique
  const search = await request(app).get('/api/listings').query({ q: 'karité', category: 'femmes' });
  assert.ok(search.body.items.some((l) => l.id === id));
  const detail = await request(app).get(`/api/listings/${id}`);
  assert.equal(detail.body.listing.photos.length, 1);

  // SM-Chat
  const self = await as(seller).post('/api/conversations').send({ listingId: id, body: 'test' });
  assert.equal(self.status, 400);
  const conv = await as(buyer).post('/api/conversations').send({ listingId: id, body: 'Bonjour, est-il disponible ?' });
  assert.equal(conv.status, 201);
  const cid = conv.body.conversation.id;
  await as(seller).post(`/api/conversations/${cid}/messages`).send({ body: 'Oui, disponible à Médina.' });
  const thread = await as(buyer).get(`/api/conversations/${cid}`);
  assert.equal(thread.body.messages.length, 2);

  // Commande : paiement direct, moyen non accepté refusé
  const om = await as(buyer).post('/api/orders').send({ listingId: id, deliveryMode: 'hand', payMethod: 'orange_money' });
  assert.equal(om.status, 400);
  const ord = await as(buyer).post('/api/orders').send({ listingId: id, quantity: 2, deliveryMode: 'hand', payMethod: 'wave' });
  assert.equal(ord.status, 201);
  assert.equal(ord.body.order.total_fcfa, 7000);
  assert.match(ord.body.order.ref, /^SM-\d+$/);
  const oid = ord.body.order.id;
  assert.equal((await as(buyer).post(`/api/orders/${oid}/status`).send({ status: 'accepted' })).status, 403);
  assert.equal((await as(seller).post(`/api/orders/${oid}/status`).send({ status: 'accepted' })).status, 200);
  assert.equal((await as(seller).post(`/api/orders/${oid}/status`).send({ status: 'scheduled', meetingPlace: 'Marché Tilène' })).status, 200);
  assert.equal((await as(buyer).post(`/api/orders/${oid}/review`).send({ rating: 5 })).status, 400);
  assert.equal((await as(buyer).post(`/api/orders/${oid}/status`).send({ status: 'completed' })).status, 200);
  const sold = await db.one('SELECT stock, status FROM listings WHERE id = $1', [id]);
  assert.deepEqual(sold, { stock: 0, status: 'sold' });
  assert.equal((await as(buyer).post(`/api/orders/${oid}/review`).send({ rating: 5, tags: ['Ponctuelle'] })).status, 201);
  assert.equal((await as(buyer).post(`/api/orders/${oid}/review`).send({ rating: 4 })).status, 400);

  // Abonnement annuel déclaré (sans API Wave configurée) puis confirmé : démarre à la fin de l'essai
  assert.equal((await as(seller).post('/api/me/subscription').send({ payMethod: 'wave' })).status, 400, 'référence obligatoire en mode manuel');
  const pay = await as(seller).post('/api/me/subscription').send({ payMethod: 'wave', payRef: 'WV-TEST-001' });
  assert.equal(pay.status, 201, JSON.stringify(pay.body)); assert.equal(pay.body.payment.total_fcfa, 2500); assert.match(pay.body.payment.ref, /^AB-\d+$/);
  const pendPay = await as(admin).get('/api/admin/revenue?status=pending');
  assert.equal((await as(admin).post(`/api/admin/payments/${pendPay.body.items[0].id}/confirm`).send({ accept: true })).status, 200);
  const annual = await db.one(`SELECT starts_at, ends_at FROM subscriptions WHERE kind = 'annual'`);
  assert.ok(new Date(annual.starts_at) - Date.now() > 13 * 864e5);
  assert.equal((await as(seller).get('/api/me')).body.credits, 2500, '500 crédits d’essai + 2 000 inclus dans l’abonnement');
  // Remboursement : double validation par deux personnes distinctes
  const pid = pendPay.body.items[0].id;
  assert.equal((await as(admin).post(`/api/admin/payments/${pid}/refund`).send({ reason: 'Demande du commerçant' })).body.status, 'refund_requested');
  assert.equal((await as(admin).post(`/api/admin/payments/${pid}/refund`).send({ reason: 'Même personne' })).status, 400);

  // Signalement + décision
  const rep = await as(buyer).post('/api/reports').send({ targetType: 'user', targetId: (await db.one(`SELECT id FROM users WHERE phone='+221770000021'`)).id, reason: 'behaviour' });
  assert.equal(rep.status, 201); assert.match(rep.body.report.ref, /^SR-\d{4}$/);
  assert.equal((await as(admin).post(`/api/admin/reports/${rep.body.report.id}/decision`).send({ decision: 'warn', note: 'Rappel des règles' })).status, 200);

  // Journal d'audit en ajout seul, empreintes chaînées intactes
  const log = await as(admin).get('/api/admin/audit');
  assert.ok(log.body.items.length >= 8);
  await assert.rejects(db.query('DELETE FROM audit_log'));
  const chain = await as(admin).get('/api/admin/audit/verify');
  assert.equal(chain.body.broken, 0); assert.ok(chain.body.total >= 8);
  // Connexion par code SMS
  const lo = await request(app).post('/api/auth/otp').send({ phone: '+221760000022', purpose: 'login' });
  assert.equal((await request(app).post('/api/auth/login-otp').send({ phone: '76 000 00 22', code: lo.body.devCode })).status, 200);

  // Membre ordinaire : pas d'accès administrateur
  assert.equal((await as(buyer).get('/api/admin/stats')).status, 403);
  const stats = await as(admin).get('/api/admin/stats');
  assert.equal(stats.status, 200, JSON.stringify(stats.body));
  assert.equal(stats.body.kpi.verified_users, 3);
});
