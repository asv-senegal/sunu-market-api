// Idempotence des demandes de création (en-tête « Idempotency-Key »).
// - Première demande : traitée normalement, la réponse réussie est conservée 24 h.
// - Même clé renvoyée ensuite : la réponse conservée est renvoyée telle quelle, rien n'est recréé.
// - Même clé pendant que la première est en cours : 409 « request_in_progress » (le site web attend puis réessaie).
// - Même clé avec un contenu différent : 422 (une clé ne sert qu'à une seule demande).
// - Réponse en erreur : la clé est libérée, la demande corrigée peut être renvoyée avec la même clé.
// Sans en-tête, la route fonctionne comme avant.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { HttpError } from './http.js';

const STALE_MS = 5 * 60_000; // une demande « en cours » depuis plus de 5 min a échoué (délais d'appel : 45 s)

const fingerprint = (req) => crypto.createHash('sha256').update(JSON.stringify([
  req.method, req.baseUrl + req.path, req.body || {},
  req.file ? [req.file.originalname, req.file.size] : null,
  (req.files || []).map((f) => [f.originalname, f.size]),
])).digest('hex');

export function idempotent(scope) {
  return async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (!key || !req.user) return next();
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new HttpError(400, 'Clé d’idempotence invalide.', 'idempotency_key');
    const userId = req.user.id;
    const fp = fingerprint(req);

    let row = await db.one(
      `INSERT INTO idempotency_keys (user_id, key, scope, fingerprint) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, key) DO NOTHING RETURNING key`, [userId, key, scope, fp]);
    if (!row) {
      const prev = await db.one('SELECT * FROM idempotency_keys WHERE user_id = $1 AND key = $2', [userId, key]);
      if (prev && (prev.scope !== scope || prev.fingerprint !== fp)) {
        throw new HttpError(422, 'Cette demande a changé : actualisez la page puis recommencez.', 'idempotency_mismatch');
      }
      if (prev?.status === 'done') {
        res.set('Idempotent-Replayed', 'true');
        return res.status(prev.http_status).json(prev.response);
      }
      // Toujours en cours : on attend, sauf si la première demande a été interrompue (serveur arrêté…)
      const stale = prev && Date.now() - new Date(prev.created_at).getTime() > STALE_MS;
      if (!stale) throw new HttpError(409, 'Cette demande est déjà en cours de traitement.', 'request_in_progress');
      // Une seule reprise possible : la ligne n'est rafraîchie que si elle est encore périmée
      row = await db.one(
        `UPDATE idempotency_keys SET created_at = now() WHERE user_id = $1 AND key = $2 AND status = 'pending'
           AND created_at < now() - make_interval(secs => $3) RETURNING key`,
        [userId, key, STALE_MS / 1000]);
      if (!row) throw new HttpError(409, 'Cette demande est déjà en cours de traitement.', 'request_in_progress');
    }

    // Enregistre le résultat avant de répondre : un doublon arrivé juste après voit déjà la réponse
    const send = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      const save = status < 400
        ? db.query(`UPDATE idempotency_keys SET status = 'done', http_status = $3, response = $4 WHERE user_id = $1 AND key = $2`, [userId, key, status, body])
        : db.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2', [userId, key]);
      save.catch((e) => console.error('[idempotence]', e.message)).finally(() => send(body));
      return res;
    };
    next();
  };
}

// Nettoyage quotidien (tâche de fond)
export const purgeIdempotencyKeys = () => db.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`);
