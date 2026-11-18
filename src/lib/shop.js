// Une annonce est visible si : annonce active, boutique active, abonnement (essai ou annuel) en cours,
// et propriétaire vérifié et non suspendu.
export const ACTIVE_SUB = `EXISTS (SELECT 1 FROM subscriptions sb WHERE sb.shop_id = sh.id AND sb.status = 'active' AND sb.ends_at > now())`;
export const VISIBLE = `l.status = 'active' AND sh.status = 'active' AND ${ACTIVE_SUB}
  AND EXISTS (SELECT 1 FROM users ow WHERE ow.id = sh.owner_id AND ow.verification_status = 'verified' AND ow.status = 'active')`;

export const currentSubscription = (db, shopId) => db.one(
  `SELECT * FROM subscriptions WHERE shop_id = $1 AND status = 'active' AND ends_at > now() ORDER BY ends_at DESC LIMIT 1`, [shopId]);

export const sellerRating = `(SELECT json_build_object('avg', round(avg(r.rating)::numeric, 1), 'count', count(*)) FROM reviews r WHERE r.target_id = sh.owner_id)`;

// Prix promotionnel d'une campagne active (affiché barré sur l'annonce, appliqué à la commande)
export const PROMO = `(SELECT pr.promo_price_fcfa FROM promotions pr WHERE pr.listing_id = l.id AND pr.kind = 'campaign' AND pr.status = 'active' AND pr.ends_at > now() ORDER BY pr.ends_at DESC LIMIT 1)`;
