import { db } from '../db.js';
import { sendSms } from './sms.js';

export const audit = (actorId, action, target, details = {}, t = db) =>
  t.query('INSERT INTO audit_log (actor_id, action, target, details) VALUES ($1,$2,$3,$4)', [actorId, action, target, details]);

// Groupes de préférences (P18) et canaux par défaut
export const NOTIF_GROUPS = {
  orders: { label: 'Commandes', kinds: ['order'], def: { app: true, sms: true, whatsapp: false } },
  messages: { label: 'Messages SM-Chat', kinds: ['message'], def: { app: true, sms: false, whatsapp: false } },
  smia: { label: 'SM-IA Et Crédits', kinds: ['smia', 'smia_low'], def: { app: true, sms: false, whatsapp: false } },
  account: { label: 'Compte, Abonnement Et Modération', kinds: ['verification', 'subscription', 'trial', 'moderation', 'report', 'promotion'], def: { app: true, sms: true, whatsapp: false } },
};
const groupOf = (kind) => Object.entries(NOTIF_GROUPS).find(([, g]) => g.kinds.includes(kind))?.[0];

export async function notify(userId, kind, title, body, link, t = db) {
  await t.query('INSERT INTO notifications (user_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5)', [userId, kind, title, body, link]);
  const g = groupOf(kind);
  if (!g) return;
  // SMS envoyé après la requête, selon les préférences du membre (WhatsApp : canal à brancher [à confirmer])
  setImmediate(async () => {
    try {
      const r = await db.one('SELECT u.phone, p.prefs FROM users u LEFT JOIN notification_prefs p ON p.user_id = u.id WHERE u.id = $1', [userId]);
      const pref = { ...NOTIF_GROUPS[g].def, ...(r?.prefs?.[g] || {}) };
      if (r && pref.sms) await sendSms(r.phone, `Sunu-Market : ${title}. ${body || ''}`.slice(0, 300));
    } catch { /* l'échec d'un SMS ne bloque jamais l'action */ }
  });
}
