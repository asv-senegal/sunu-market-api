-- Idempotence des créations (paiements, commandes, SM-IA, messages) : une même demande renvoyée
-- (double clic, nouvel essai réseau, formulaire renvoyé) ne crée rien une deuxième fois.

-- Une ligne par clé envoyée dans l'en-tête « Idempotency-Key » ; la réponse est conservée 24 heures
CREATE TABLE idempotency_keys (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key          text NOT NULL,
  scope        text NOT NULL,                 -- route concernée
  fingerprint  text NOT NULL,                 -- empreinte du contenu : une clé ne sert qu'à une seule demande
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  http_status  int,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX ON idempotency_keys (created_at);

-- Une référence de transaction déclarée (Wave, Orange Money) ne peut servir qu'à un seul paiement
-- (sauf si ce paiement a été rejeté ou a expiré)
CREATE UNIQUE INDEX payments_manual_ref_unique ON payments (upper(btrim(provider_ref)))
  WHERE provider = 'manual' AND provider_ref IS NOT NULL AND status NOT IN ('failed','expired');
