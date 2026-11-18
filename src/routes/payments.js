// Paiements des services : suivi, retour du prestataire, webhooks
import { Router } from 'express';
import { db } from '../db.js';
import { notFound } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import { refreshPayment, markPaid, waveVerify, purposeLabel } from '../lib/payments.js';

const r = Router();

r.get('/:ref', requireAuth, async (req, res) => {
  let p = await db.one('SELECT * FROM payments WHERE ref = $1 AND user_id = $2', [req.params.ref, req.user.id]);
  if (!p) throw notFound('Paiement introuvable.');
  p = await refreshPayment(p).catch(() => p);
  res.json({ payment: { ...p, label: purposeLabel(p.purpose) } });
});

export default r;

// Webhook Wave (corps brut nécessaire à la vérification de la signature)
export async function waveWebhook(req, res) {
  const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
  if (!waveVerify(req.get('wave-signature'), raw)) return res.status(401).json({ error: 'signature invalide' });
  const evt = JSON.parse(raw);
  const ref = evt?.data?.client_reference;
  if (evt?.type === 'checkout.session.completed' && ref) {
    const p = await db.one(`SELECT * FROM payments WHERE ref = $1 AND provider = 'wave'`, [ref]);
    // Double contrôle : on relit l'état de la session auprès de Wave avant d'activer le service
    if (p) await refreshPayment(p).catch((e) => console.error('[Wave]', e.message));
  }
  res.json({ received: true });
}

// Notification Orange Money : on ne fait pas confiance au contenu, on relit l'état auprès de l'API
export async function orangeWebhook(req, res) {
  const ref = req.body?.order_id || req.body?.orderId;
  if (ref) {
    const p = await db.one(`SELECT * FROM payments WHERE ref = $1 AND provider = 'orange_money'`, [String(ref)]);
    if (p) await refreshPayment(p).catch((e) => console.error('[Orange Money]', e.message));
  }
  res.json({ received: true });
}
export { markPaid };
