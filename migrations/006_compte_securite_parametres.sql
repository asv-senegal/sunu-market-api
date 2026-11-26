-- Version 0.3 (migration 006) : mot de passe oublié, sécurité et données (loi n° 2008-12), paramètres de boutique

-- Code SMS pour réinitialiser le mot de passe
ALTER TABLE sms_codes DROP CONSTRAINT IF EXISTS sms_codes_purpose_check;
ALTER TABLE sms_codes ADD CONSTRAINT sms_codes_purpose_check CHECK (purpose IN ('register','login','reset'));

-- Demande de suppression du compte : traitée par l'équipe après un délai de rétractation [durée à confirmer]
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;

-- Paramètres de boutique (P20 « Paramètres ») : horaires, lieu de remise habituel, modes de remise et paiements acceptés
ALTER TABLE shops ADD COLUMN IF NOT EXISTS hours text;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS meeting_place text;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS delivery_modes text[] NOT NULL DEFAULT '{hand}';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS pay_methods text[] NOT NULL DEFAULT '{wave,orange_money,cash}';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS vacation boolean NOT NULL DEFAULT false;
