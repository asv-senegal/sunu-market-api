-- Rappels d'échéance de l'abonnement (essai ou annuel) et rapprochement des paiements en ligne.

-- Un rappel par abonnement et par étape : jamais envoyé deux fois, même avec plusieurs serveurs.
CREATE TABLE subscription_reminders (
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  stage           text NOT NULL CHECK (stage IN ('7d','1d','expired')),
  sent_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subscription_id, stage)
);

-- Recherche rapide des paiements en ligne encore en attente
CREATE INDEX IF NOT EXISTS payments_pending_live ON payments (created_at) WHERE status = 'pending' AND provider <> 'manual';

-- Dernier contrôle auprès du prestataire (pour espacer les relances)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS checked_at timestamptz;
