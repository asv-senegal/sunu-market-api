import { fileURLToPath } from 'node:url';
// SM-IA, crédits, recharges et visibilité payante. L'API Anthropic est remplacée par un simulateur local
// qui respecte le format de l'API Messages (blocs text et tool_use, champ usage).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execSync } from 'node:child_process';
import request from 'supertest';

process.env.STORAGE_DIR = '/tmp/sunu-test-storage';
const calls = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const b = JSON.parse(body);
    calls.push(b);
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(req.headers['x-api-key'], 'cle-de-test');
    const names = (b.tools || []).map((t) => t.name);
    const lastUser = JSON.stringify(b.messages.at(-1).content);
    let content;
    if (names.includes('ecrire_annonce')) {
      content = [{ type: 'tool_use', id: 't1', name: 'ecrire_annonce', input: { title: 'Smartphone Android 128 Go', description: 'Téléphone en très bon état, batterie testée.' } }];
    } else if (names.includes('resultat')) {
      content = [{ type: 'tool_use', id: 't1', name: 'resultat', input: lastUser.includes('guérit') ? { verdict: 'a_verifier', motifs: ['Allégation médicale'] } : { verdict: 'ok' } }];
    } else if (names.includes('transmettre_au_commercant')) {
      const orders = JSON.parse(b.system.match(/Commandes en cours dans cette conversation : (\[.*?\])\n/s)[1]);
      if (lastUser.includes('remise')) {
        content = [{ type: 'text', text: 'Je transmets votre demande de remise au commerçant.' },
          { type: 'tool_use', id: 't2', name: 'transmettre_au_commercant', input: { type: 'remise', resume: 'L’acheteur demande 10 % de remise.' } }];
      } else {
        content = [{ type: 'text', text: 'Bonjour, l’article est disponible. Je confirme votre commande.' },
          ...orders.filter((o) => o.status === 'new').map((o) => ({ type: 'tool_use', id: `a-${o.id}`, name: 'accepter_commande', input: { order_id: o.id } }))];
      }
    } else if (names.includes('proposer_action')) {
      const id = b.system.match(/"id":"([0-9a-f-]{36})"/)[1];
      content = [{ type: 'text', text: 'Votre titre peut être plus précis.' },
        { type: 'tool_use', id: 't3', name: 'proposer_action', input: { kind: 'listing_update', listing_id: id, summary: 'Titre plus précis', title: 'Smartphone Android 128 Go, garanti entre membres' } }];
    } else content = [{ type: 'text', text: 'ok' }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: b.model, content, stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 300 } }));
  });
});

const { db } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { signToken } = await import('../src/lib/auth.js');
const smia = await import('../src/lib/smia.js');
const app = createApp();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const as = (tok) => ({ get: (u) => request(app).get(u).set('Authorization', `Bearer ${tok}`), post: (u) => request(app).post(u).set('Authorization', `Bearer ${tok}`), patch: (u) => request(app).patch(u).set('Authorization', `Bearer ${tok}`) });
let seller, buyer, admin, sellerId;

before(async () => {
  await new Promise((ok) => mock.listen(0, '127.0.0.1', ok));
  process.env.ANTHROPIC_API_KEY = 'cle-de-test';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  execSync('node scripts/migrate.js && node scripts/seed.js --demo', { cwd: fileURLToPath(new URL('..', import.meta.url)), env: process.env, stdio: 'ignore' });
  const id = async (phone) => (await db.one('SELECT id FROM users WHERE phone = $1', [phone])).id;
  sellerId = await id('+221700000012');
  seller = signToken({ id: sellerId }); buyer = signToken({ id: await id('+221700000015') }); admin = signToken({ id: await id('+221700000001') });
});
after(async () => { mock.close(); await db.end(); });

test('crédits, recharge et barème', async () => {
  const q = await as(seller).get('/api/me/smia/quote?amount=10000');
  assert.deepEqual(q.body, { amount: 10000, credits: 40000, commission: 100, total: 10100 }, '1 % de 10 000 FCFA = 100 FCFA');
  assert.equal((await as(seller).post('/api/me/smia/recharge').send({ amount: 300, payMethod: 'wave', payRef: 'WV-1' })).status, 400, 'minimum 500 FCFA');
  const rc = await as(seller).post('/api/me/smia/recharge').send({ amount: 2000, payMethod: 'orange_money', payRef: 'OM-778899' });
  assert.equal(rc.status, 201); assert.equal(rc.body.payment.total_fcfa, 2020); assert.equal(rc.body.payment.credits, 8000);
  assert.equal((await as(admin).post(`/api/admin/payments/${rc.body.payment.id}/confirm`).send({ accept: true })).status, 200);
  const s = await as(seller).get('/api/me/smia');
  assert.equal(s.body.balance, 8500, '500 crédits d’essai + 8 000 rechargés');
  assert.equal(s.body.pricing.packs.length, 3);
});

test('rédaction d’annonce facturée au token', async () => {
  const d = await as(seller).post('/api/me/smia/describe').send({ title: 'tel android', notes: '128 go bon etat' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.title, 'Smartphone Android 128 Go');
  // 1 500 tokens × 0,10 $ + 300 × 0,50 $ par million = 0,0003 $ → 3 crédits de 0,0001 $
  assert.equal(d.body.credits, 3);
  const c = await db.one(`SELECT cost_usd::float, credits FROM ai_calls WHERE feature = 'description'`);
  assert.equal(c.credits, 3); assert.ok(Math.abs(c.cost_usd - 0.0003) < 1e-9);
  assert.equal((await as(seller).get('/api/me/smia')).body.balance, 8497);
  assert.equal(calls.at(-1).model, 'claude-haiku-5-5');
});

test('SM-IA Commandes : acceptation dans les limites, transmission des remises', async () => {
  assert.equal((await as(seller).patch('/api/me/smia').send({ chatbot_enabled: true, chatbot_mode: 'always', max_order_fcfa: 50000 })).status, 200);
  const l = await db.one(`SELECT l.id FROM listings l JOIN shops sh ON sh.id = l.shop_id WHERE sh.owner_id = $1 AND l.price_fcfa = 32000`, [sellerId]);
  const o = await as(buyer).post('/api/orders').send({ listingId: l.id, deliveryMode: 'hand', payMethod: 'cash' });
  assert.equal(o.status, 201);
  await smia.idle();
  assert.equal((await db.one('SELECT status FROM orders WHERE id = $1', [o.body.order.id])).status, 'accepted');
  const thread = await as(buyer).get(`/api/conversations/${o.body.order.conversation_id}`);
  assert.ok(thread.body.messages.some((m) => m.kind === 'ai'));
  assert.equal(thread.body.conversation.smiaActive, true);
  // Une commande au-dessus du plafond n'est jamais acceptée seule
  const big = await db.one(`SELECT l.id FROM listings l JOIN shops sh ON sh.id = l.shop_id WHERE sh.owner_id = $1 AND l.price_fcfa = 120000`, [sellerId]);
  const o2 = await as(buyer).post('/api/orders').send({ listingId: big.id, deliveryMode: 'hand', payMethod: 'cash' });
  await smia.idle();
  assert.equal((await db.one('SELECT status FROM orders WHERE id = $1', [o2.body.order.id])).status, 'new');
  assert.ok(await db.one(`SELECT 1 FROM ai_actions WHERE kind = 'accept_order' AND status = 'blocked'`));
  // Demande de remise : transmise, en attente de l'accord du commerçant
  await as(buyer).post(`/api/conversations/${o.body.order.conversation_id}/messages`).send({ body: 'Vous pouvez faire une remise ?' });
  await smia.idle();
  const pending = (await as(seller).get('/api/me/smia')).body.pending;
  assert.ok(pending.some((a) => a.kind === 'remise_request'));
});

test('assistant : proposition soumise à accord, puis appliquée', async () => {
  const a = await as(seller).post('/api/me/smia/assistant').send({ text: 'Comment mieux vendre mon téléphone ?' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const p = a.body.proposals[0];
  assert.equal(p.status, 'pending');
  const before = await db.one('SELECT title FROM listings WHERE id = $1', [p.listing_id]);
  assert.notEqual(before.title, 'Smartphone Android 128 Go, garanti entre membres');
  assert.equal((await as(seller).post(`/api/me/smia/actions/${p.id}/approve`)).status, 200);
  assert.equal((await db.one('SELECT title FROM listings WHERE id = $1', [p.listing_id])).title, 'Smartphone Android 128 Go, garanti entre membres');
});

test('garde-fous : solde, plafond quotidien, coupures', async () => {
  await db.query('UPDATE credit_wallets SET balance = 1 WHERE user_id = $1', [sellerId]);
  assert.equal((await as(seller).post('/api/me/smia/describe').send({ title: 'x', notes: 'y' })).status, 402);
  await db.query('UPDATE credit_wallets SET balance = 5000 WHERE user_id = $1', [sellerId]);
  await as(seller).patch('/api/me/smia').send({ daily_credit_cap: 0 });
  assert.equal((await as(seller).post('/api/me/smia/describe').send({ title: 'x' })).status, 429);
  await as(seller).patch('/api/me/smia').send({ daily_credit_cap: 500 });
  await as(seller).post('/api/me/smia/power').send({ on: false });
  assert.equal((await as(seller).post('/api/me/smia/describe').send({ title: 'x' })).status, 403);
  await as(seller).post('/api/me/smia/power').send({ on: true });
  assert.equal((await as(admin).post('/api/admin/smia/power').send({ on: false })).status, 200);
  assert.equal((await as(seller).post('/api/me/smia/describe').send({ title: 'x' })).status, 503);
  await as(admin).post('/api/admin/smia/power').send({ on: true });
  assert.equal((await as(seller).post('/api/me/smia/describe').send({ title: 'x' })).status, 200);
  const k = await as(admin).get('/api/admin/smia');
  assert.ok(k.body.kpi.cost_usd_month > 0); assert.equal(k.body.kpi.commissions_month, 20);
});

test('modération automatique et visibilité payante', async () => {
  await as(admin).patch('/api/admin/settings/smia_moderation_enabled').send({ value: true });
  const sub = await db.one(`SELECT s.id FROM subcategories s WHERE s.slug = 'beaute'`);
  const l = await as(seller).post('/api/listings').field('subcategoryId', sub.id).field('title', 'Huile miracle 100 ml').field('description', 'Elle guérit le paludisme')
    .field('priceFcfa', 3000).field('condition', 'new').field('payMethods', 'cash').attach('photos', PNG, { filename: 'p.png', contentType: 'image/png' });
  assert.equal(l.status, 201, JSON.stringify(l.body));
  await smia.idle();
  assert.ok(await db.one(`SELECT 1 FROM reports WHERE target_id = $1 AND reporter_id IS NULL`, [l.body.id]), 'signalement automatique');
  const photo = await db.one('SELECT url FROM listing_photos WHERE listing_id = $1', [l.body.id]);
  assert.match(photo.url, /\.webp$/, 'photo compressée en WebP');

  const phone = await db.one(`SELECT l.id FROM listings l JOIN shops sh ON sh.id = l.shop_id WHERE sh.owner_id = $1 AND l.price_fcfa = 5000`, [sellerId]);
  const unset = await as(seller).post('/api/me/promotions').field('kind', 'featured').field('listingId', phone.id).field('days', 7).field('payMethod', 'wave').field('payRef', 'WV-55');
  assert.equal(unset.status, 409, 'tarif non fixé : service désactivé');
  await as(admin).patch('/api/admin/settings/featured_price_per_day_fcfa').send({ value: 150 });
  const f = await as(seller).post('/api/me/promotions').field('kind', 'featured').field('listingId', phone.id).field('days', 7).field('payMethod', 'wave').field('payRef', 'WV-55');
  assert.equal(f.status, 201, JSON.stringify(f.body)); assert.equal(f.body.payment.total_fcfa, 1050); assert.match(f.body.payment.ref, /^MA-/);
  await as(admin).post(`/api/admin/payments/${f.body.payment.id}/confirm`).send({ accept: true });
  const card = (await request(app).get('/api/listings').query({ shop: 'moussa-tech' })).body.items.find((x) => x.id === phone.id);
  assert.equal(card.featured, true);

  await as(admin).patch('/api/admin/settings/campaign_price_per_day_fcfa').send({ value: 200 });
  const c = await as(seller).post('/api/me/promotions').field('kind', 'campaign').field('listingId', phone.id).field('days', 5).field('promoPrice', 4000).field('payMethod', 'wave').field('payRef', 'WV-56');
  assert.equal(c.status, 201, JSON.stringify(c.body));
  await as(admin).post(`/api/admin/payments/${c.body.payment.id}/confirm`).send({ accept: true });
  const o = await as(buyer).post('/api/orders').send({ listingId: phone.id, deliveryMode: 'hand', payMethod: 'cash' });
  assert.equal(o.body.order.unit_price_fcfa, 4000, 'prix promotionnel appliqué');
  assert.ok((await request(app).get('/api/shops?sort=featured')).body.items.some((s) => s.slug === 'moussa-tech'));

  await as(admin).patch('/api/admin/settings/ad_price_per_day_fcfa').send({ value: 500 });
  const ad = await as(seller).post('/api/me/promotions').field('kind', 'ad').field('title', 'Moussa Tech : téléphones testés').field('placement', 'home').field('days', 3)
    .field('payMethod', 'orange_money').field('payRef', 'OM-1').attach('image', PNG, { filename: 'b.png', contentType: 'image/png' });
  assert.equal(ad.status, 201, JSON.stringify(ad.body));
  await as(admin).post(`/api/admin/payments/${ad.body.payment.id}/confirm`).send({ accept: true });
  assert.equal((await request(app).get('/api/ads?placement=home')).body.items.length, 1);
  const rev = await as(admin).get('/api/admin/revenue');
  assert.ok(rev.body.kpi.some((k) => k.purpose === 'ad' && k.amount === 1500));
});

test('webhook Wave : signature vérifiée', async () => {
  process.env.WAVE_WEBHOOK_SECRET = 'secret-de-test';
  const body = JSON.stringify({ type: 'checkout.session.completed', data: { client_reference: 'IA-9999' } });
  assert.equal((await request(app).post('/api/payments/webhooks/wave').set('Wave-Signature', 't=1,v1=abc').set('Content-Type', 'application/json').send(body)).status, 401);
  const crypto = await import('node:crypto');
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'secret-de-test').update(ts + body).digest('hex');
  assert.equal((await request(app).post('/api/payments/webhooks/wave').set('Wave-Signature', `t=${ts},v1=${sig}`).set('Content-Type', 'application/json').send(body)).status, 200);
});
