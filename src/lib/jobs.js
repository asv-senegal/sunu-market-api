// Tâches de fond du serveur API :
// 1. Rapprochement des paiements en ligne (Wave, Orange Money) restés « en attente » : si la notification du
//    prestataire se perd et que le membre ne revient pas sur la page de paiement, on relit l'état chez le prestataire.
// 2. Rappels d'échéance de l'abonnement (essai ou annuel) : 7 jours avant, la veille, puis à l'expiration.
// Chaque tâche prend un verrou PostgreSQL : avec plusieurs serveurs, une seule exécution à la fois.
import { db } from '../db.js';
import { notify } from './audit.js';
import { refreshPayment } from './payments.js';
import { setting } from './settings.js';
import { purgeIdempotencyKeys } from './idempotency.js';

const DAY = 864e5;
const fmt = (n) => Number(n).toLocaleString('fr-FR').replace(/[  ]/g, ' ');
const dateFr = (d) => new Date(d).toLocaleDateString('fr-FR', { timeZone: 'Africa/Dakar', day: 'numeric', month: 'long', year: 'numeric' });

// Exécute fn seulement si aucun autre serveur ne tient le verrou de cette tâche
async function exclusive(name, fn) {
  return db.tx(async (t) => {
    const { ok } = await t.one('SELECT pg_try_advisory_xact_lock(hashtext($1)) ok', [`sunu:${name}`]);
    return ok ? fn(t) : { skipped: true };
  });
}

// ---------- 1. Rapprochement des paiements en ligne ----------
// Espacement des contrôles selon l'âge du paiement : toutes les 2 min la première heure,
// toutes les 30 min le premier jour, puis toutes les 6 h jusqu'à 7 jours (ensuite : examen par l'équipe).
export async function reconcilePayments({ at = new Date(), limit = 50 } = {}) {
  return exclusive('reconcile', async (t) => {
    const due = await t.many(
      `SELECT * FROM payments
       WHERE status = 'pending' AND provider <> 'manual' AND created_at > $1::timestamptz - interval '7 days'
         AND (checked_at IS NULL OR checked_at < $1::timestamptz - CASE
               WHEN created_at > $1::timestamptz - interval '1 hour' THEN interval '2 minutes'
               WHEN created_at > $1::timestamptz - interval '1 day' THEN interval '30 minutes'
               ELSE interval '6 hours' END)
       ORDER BY checked_at NULLS FIRST, created_at LIMIT $2`, [at, limit]);
    const out = { checked: 0, paid: 0, closed: 0, errors: 0 };
    for (const p of due) {
      // Hors de la transaction du verrou : markPaid verrouille la même ligne depuis sa propre transaction
      await db.query('UPDATE payments SET checked_at = $2 WHERE id = $1', [p.id, at]);
      try {
        const r = await refreshPayment(p);
        out.checked++;
        if (r.status === 'paid') out.paid++;
        else if (r.status !== 'pending') out.closed++;
      } catch (e) {
        out.errors++;
        console.error(`[rapprochement] ${p.ref} : ${e.message}`);
      }
    }
    return out;
  });
}

// ---------- 2. Rappels d'échéance ----------
const stageOf = (endsAt, at) => {
  const left = new Date(endsAt).getTime() - at.getTime();
  if (left <= 0) return 'expired';
  if (left <= DAY) return '1d';
  if (left <= 7 * DAY) return '7d';
  return null;
};

function message(stage, kind, endsAt, price) {
  const what = kind === 'trial' ? 'votre essai gratuit' : 'votre abonnement annuel';
  const What = kind === 'trial' ? 'Votre Essai' : 'Votre Abonnement';
  const offer = `l’abonnement annuel (${fmt(price)} FCFA)`;
  if (stage === '7d') return [`${What} Se Termine Bientôt`, `${what[0].toUpperCase()}${what.slice(1)} se termine le ${dateFr(endsAt)}. ${kind === 'trial' ? `Activez ${offer}` : 'Renouvelez-le'} pour garder votre boutique en ligne.`];
  if (stage === '1d') return [`${What} Se Termine Demain`, `${what[0].toUpperCase()}${what.slice(1)} se termine dans moins de 24 heures. ${kind === 'trial' ? `Activez ${offer}` : 'Renouvelez-le'} pour que vos annonces restent visibles.`];
  return ['Votre Boutique Est Hors Ligne', `${what[0].toUpperCase()}${what.slice(1)} a pris fin le ${dateFr(endsAt)} : vos annonces sont masquées. Activez ${offer} pour les remettre en ligne.`];
}

// Ne concerne que la dernière période de chaque boutique active, sans paiement d'abonnement en attente.
// Si le serveur était arrêté, seule l'étape la plus récente est envoyée (pas de rattrapage en rafale).
export async function sendSubscriptionReminders({ at = new Date() } = {}) {
  return exclusive('reminders', async (t) => {
    const price = Number(await setting('subscription_annual_fcfa')) || 0;
    const subs = await t.many(
      `SELECT s.id, s.kind, s.ends_at, sh.owner_id
       FROM subscriptions s JOIN shops sh ON sh.id = s.shop_id
       WHERE s.status = 'active' AND sh.status = 'active'
         AND s.ends_at BETWEEN $1::timestamptz - interval '3 days' AND $1::timestamptz + interval '7 days'
         AND s.ends_at = (SELECT max(s2.ends_at) FROM subscriptions s2 WHERE s2.shop_id = s.shop_id AND s2.status = 'active')
         AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.shop_id = sh.id AND p.purpose = 'subscription' AND p.status = 'pending')`, [at]);
    const out = { sent: 0, byStage: {} };
    for (const s of subs) {
      const stage = stageOf(s.ends_at, at);
      if (!stage) continue;
      const fresh = await t.one(
        `INSERT INTO subscription_reminders (subscription_id, stage) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING stage`, [s.id, stage]);
      if (!fresh) continue;
      const [title, body] = message(stage, s.kind, s.ends_at, price);
      await notify(s.owner_id, 'subscription', title, body, '/ma-boutique/abonnement', t);
      out.sent++; out.byStage[stage] = (out.byStage[stage] || 0) + 1;
    }
    return out;
  });
}

// ---------- Démarrage ----------
let timers = [];
export function startJobs() {
  if (timers.length) return;
  const every = (name, ms, fn) => {
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        const r = await fn();
        if (r && !r.skipped && (r.checked || r.sent)) console.log(`[${name}]`, JSON.stringify(r));
      } catch (e) { console.error(`[${name}] ${e.message}`); } finally { running = false; }
    };
    timers.push(setTimeout(run, 15_000), setInterval(run, ms));
  };
  every('rapprochement', 60_000, () => reconcilePayments());
  every('rappels', 30 * 60_000, () => sendSubscriptionReminders());
  every('nettoyage', 60 * 60_000, async () => { await purgeIdempotencyKeys(); return null; });
}
export function stopJobs() { timers.forEach((x) => { clearTimeout(x); clearInterval(x); }); timers = []; }
