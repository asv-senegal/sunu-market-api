// Paiements des services de la plateforme (abonnement, crédits SM-IA, visibilité).
// Les ventes entre membres ne passent jamais par ici.
// Modes : API Wave Checkout (WAVE_API_KEY), API Orange Money Web Payment (OM_*), sinon déclaration manuelle confirmée par l'équipe.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { audit, notify } from './audit.js';
import { move, pricing } from './credits.js';
import { bad, HttpError } from './http.js';

const PREFIX = { subscription: 'AB', credits: 'IA', featured: 'MA', campaign: 'CP', ad: 'PB' };
const LABEL = { subscription: 'Abonnement annuel', credits: 'Recharge de crédits SM-IA', featured: 'Mise en avant', campaign: 'Campagne promotionnelle', ad: 'Publicité' };
export const purposeLabel = (p) => LABEL[p];

export const liveProviders = () => ({
  wave: !!process.env.WAVE_API_KEY,
  orange_money: !!(process.env.OM_CLIENT_ID && process.env.OM_CLIENT_SECRET && process.env.OM_MERCHANT_KEY && process.env.OM_WEBPAY_URL),
});

// ---------- Wave Checkout ----------
async function waveCreate(p) {
  const body = JSON.stringify({
    amount: String(p.total_fcfa), currency: 'XOF', client_reference: p.ref,
    success_url: `${config.webOrigin}/paiement/${p.ref}?retour=succes`, error_url: `${config.webOrigin}/paiement/${p.ref}?retour=erreur`,
  });
  const headers = { Authorization: `Bearer ${process.env.WAVE_API_KEY}`, 'Content-Type': 'application/json' };
  if (process.env.WAVE_SIGNING_SECRET) { // signature des requêtes (option du compte Wave)
    const ts = Math.floor(Date.now() / 1000);
    headers['Wave-Signature'] = `t=${ts},v1=${crypto.createHmac('sha256', process.env.WAVE_SIGNING_SECRET).update(ts + body).digest('hex')}`;
  }
  const r = await fetch(`${process.env.WAVE_API_URL || 'https://api.wave.com'}/v1/checkout/sessions`, { method: 'POST', headers, body });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw bad(`Wave indisponible (${d.message || r.status}). Réessayez ou choisissez un autre moyen.`, 'wave_error');
  return { providerRef: d.id, url: d.wave_launch_url };
}
async function waveStatus(sessionId) {
  const r = await fetch(`${process.env.WAVE_API_URL || 'https://api.wave.com'}/v1/checkout/sessions/${sessionId}`, { headers: { Authorization: `Bearer ${process.env.WAVE_API_KEY}` } });
  if (!r.ok) return null;
  const d = await r.json();
  if (d.payment_status === 'succeeded' || d.checkout_status === 'complete') return 'paid';
  if (d.checkout_status === 'expired') return 'expired';
  return 'pending';
}
// Webhook Wave : en-tête « Wave-Signature: t=<horodatage>,v1=<hmac> », HMAC-SHA256 de l'horodatage suivi du corps brut
export function waveVerify(header, rawBody) {
  const secret = process.env.WAVE_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((x) => x.split('=')));
  const ts = parts.t;
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const sigs = String(header).split(',').filter((x) => x.startsWith('v1=')).map((x) => x.slice(3));
  const expected = crypto.createHmac('sha256', secret).update(ts + rawBody).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

// ---------- Orange Money Web Payment (Sonatel) ----------
// Points d'accès et format à valider avec la documentation remise lors de l'ouverture du compte marchand [à confirmer].
async function omToken() {
  const r = await fetch(process.env.OM_TOKEN_URL || 'https://api.orange.com/oauth/v3/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${process.env.OM_CLIENT_ID}:${process.env.OM_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw bad('Orange Money indisponible. Réessayez plus tard.', 'om_error');
  return (await r.json()).access_token;
}
async function omCreate(p) {
  const r = await fetch(process.env.OM_WEBPAY_URL, {
    method: 'POST', headers: { Authorization: `Bearer ${await omToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      merchant_key: process.env.OM_MERCHANT_KEY, currency: process.env.OM_CURRENCY || 'XOF', order_id: p.ref, amount: p.total_fcfa,
      return_url: `${config.webOrigin}/paiement/${p.ref}?retour=succes`, cancel_url: `${config.webOrigin}/paiement/${p.ref}?retour=erreur`,
      notif_url: `${process.env.API_PUBLIC_URL || ''}/api/payments/webhooks/orange-money`, lang: 'fr',
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.payment_url) throw bad('Orange Money indisponible. Réessayez plus tard.', 'om_error');
  return { providerRef: d.pay_token || d.payment_id || null, url: d.payment_url };
}
async function omStatus(p) {
  if (!process.env.OM_STATUS_URL) return null;
  const r = await fetch(`${process.env.OM_STATUS_URL}/${encodeURIComponent(p.provider_ref || p.ref)}`, { headers: { Authorization: `Bearer ${await omToken()}` } });
  if (!r.ok) return null;
  const d = await r.json();
  const s = String(d.status || '').toUpperCase();
  return s === 'SUCCESS' || s === 'SUCCESSFULL' ? 'paid' : s === 'FAILED' || s === 'EXPIRED' ? 'failed' : 'pending';
}

// Crée un paiement et, si l'API du moyen choisi est configurée, une session de paiement
export async function createPayment({ userId, shopId = null, purpose, purposeId = null, amount, commission = 0, credits = null, provider, payRef = null }) {
  const live = liveProviders()[provider];
  const ref = `${PREFIX[purpose]}-${(await db.one(`SELECT nextval('payment_seq')::int n`)).n}`;
  const p = await db.one(
    `INSERT INTO payments (ref, user_id, shop_id, purpose, purpose_id, amount_fcfa, commission_fcfa, total_fcfa, credits, provider, provider_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [ref, userId, shopId, purpose, purposeId, amount, commission, amount + commission, credits, live ? provider : 'manual', live ? null : payRef?.trim()])
    .catch((e) => {
      // Index unique : une référence déclarée ne sert qu'à un seul paiement (migration 004)
      if (e.code === '23505' && String(e.constraint || e.message).includes('payments_manual_ref_unique')) {
        throw new HttpError(409, 'Cette référence de transaction a déjà été déclarée. Vérifiez le SMS reçu ou contactez l’équipe.', 'pay_ref_used');
      }
      throw e;
    });
  if (live) {
    const s = provider === 'wave' ? await waveCreate(p) : await omCreate(p);
    return db.one('UPDATE payments SET provider_ref = $2, checkout_url = $3 WHERE id = $1 RETURNING *', [p.id, s.providerRef, s.url]);
  }
  await audit(userId, 'payment.declared', `payment:${p.id}`, { ref, purpose, total: p.total_fcfa, method: provider, payRef });
  return { ...p, declared_method: provider };
}

// Interroge le prestataire pour un paiement en attente (retour de l'utilisateur, ou tâche de contrôle)
export async function refreshPayment(p) {
  if (p.status !== 'pending' || p.provider === 'manual') return p;
  const s = p.provider === 'wave' ? (p.provider_ref ? await waveStatus(p.provider_ref) : null) : await omStatus(p);
  if (s === 'paid') return markPaid(p.id, null);
  // Seulement s'il est encore en attente : une confirmation arrivée entre-temps (webhook, équipe) n'est jamais écrasée
  if (s === 'expired' || s === 'failed') {
    return (await db.one(`UPDATE payments SET status = $2, updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`, [p.id, s]))
      || db.one('SELECT * FROM payments WHERE id = $1', [p.id]);
  }
  return p;
}

// Paiement confirmé : active le service acheté (une seule fois)
export async function markPaid(paymentId, actorId) {
  return db.tx(async (t) => {
    const p = await t.one(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    if (!p) throw bad('Paiement introuvable.');
    if (p.status === 'paid') return p;
    if (p.status !== 'pending') throw bad('Ce paiement ne peut plus être confirmé.');
    const u = await t.one(`UPDATE payments SET status = 'paid', paid_at = now(), confirmed_by = $2, updated_at = now() WHERE id = $1 RETURNING *`, [p.id, actorId]);
    if (p.purpose === 'subscription') {
      const cur = await t.one(`SELECT max(ends_at) e FROM subscriptions WHERE shop_id = $1 AND status = 'active'`, [p.shop_id]);
      const start = cur?.e && new Date(cur.e) > new Date() ? cur.e : new Date();
      await t.query(`INSERT INTO subscriptions (shop_id, kind, amount_fcfa, starts_at, ends_at, status, pay_method, pay_ref, confirmed_by, payment_id)
        VALUES ($1,'annual',$2,$3,$3::timestamptz + interval '1 year','active',$4,$5,$6,$7)`,
        [p.shop_id, p.amount_fcfa, start, p.provider === 'manual' ? null : p.provider, p.provider_ref, actorId, p.id]);
      const pr = await pricing();
      if (pr.subscriptionCredits > 0) await move(t, p.user_id, pr.subscriptionCredits, 'grant_subscription', { note: 'Crédits SM-IA inclus dans l’abonnement annuel', paymentId: p.id });
      await notify(p.user_id, 'subscription', 'Abonnement Activé', `Votre abonnement annuel est actif. ${pr.subscriptionCredits} crédits SM-IA ont été ajoutés.`, '/ma-boutique/abonnement', t);
    } else if (p.purpose === 'credits') {
      await move(t, p.user_id, p.credits, 'recharge', { note: `Recharge ${p.ref}`, paymentId: p.id });
      await notify(p.user_id, 'smia', 'Crédits SM-IA Rechargés', `${p.credits.toLocaleString('fr-FR')} crédits ajoutés à votre solde.`, '/ma-boutique/sm-ia', t);
    } else {
      const pr = await t.one(`UPDATE promotions SET status = 'active', starts_at = now(), ends_at = now() + make_interval(days => days) WHERE id = $1 RETURNING *`, [p.purpose_id]);
      if (pr?.listing_id && pr.kind !== 'ad') await t.query('UPDATE listings SET featured_until = greatest(coalesce(featured_until, now()), $2) WHERE id = $1', [pr.listing_id, pr.ends_at]);
      await notify(p.user_id, 'promotion', `${LABEL[p.purpose]} Lancée`, `Active jusqu’au ${new Date(pr.ends_at).toLocaleDateString('fr-FR', { timeZone: 'Africa/Dakar' })}.`, '/ma-boutique/visibilite', t);
    }
    await audit(actorId, 'payment.paid', `payment:${p.id}`, { ref: p.ref, purpose: p.purpose, total: p.total_fcfa, provider: p.provider }, t);
    return u;
  });
}
