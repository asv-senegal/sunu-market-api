-- Sunu-Market v0.2 : SMS, paiements des services, crédits SM-IA, visibilité payante,
-- signalements détaillés, rôles, préférences de notification, journal d'audit chaîné.

-- ---------- Rôles de l'équipe ----------
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('member','moderator','finance','support','admin'));
ALTER TABLE users ADD COLUMN phone_verified_at timestamptz;
ALTER TABLE users ADD COLUMN last_seen_at timestamptz;

-- ---------- Codes SMS (stockés hachés) ----------
CREATE TABLE sms_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('register','login')),
  code_hash   text NOT NULL,
  attempts    int  NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sms_codes (phone, created_at DESC);

-- ---------- Annonces : brouillons ----------
ALTER TABLE listings DROP CONSTRAINT listings_status_check;
ALTER TABLE listings ADD CONSTRAINT listings_status_check CHECK (status IN ('draft','active','paused','sold','removed'));

-- ---------- SM-Chat : images et réponses SM-IA ----------
ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text','system','order','ai','image'));
ALTER TABLE messages ADD COLUMN image_url text;

-- ---------- Paiements des services de la plateforme ----------
-- Jamais pour une vente entre membres : uniquement abonnement, crédits SM-IA, visibilité.
CREATE SEQUENCE payment_seq START 1000;
CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref             text NOT NULL UNIQUE,
  user_id         uuid NOT NULL REFERENCES users(id),
  shop_id         uuid REFERENCES shops(id),
  purpose         text NOT NULL CHECK (purpose IN ('subscription','credits','featured','campaign','ad')),
  purpose_id      uuid,                       -- promotion liée, le cas échéant
  amount_fcfa     int  NOT NULL CHECK (amount_fcfa > 0),
  commission_fcfa int  NOT NULL DEFAULT 0,
  total_fcfa      int  NOT NULL,
  credits         int,                        -- crédits achetés (recharge)
  provider        text NOT NULL CHECK (provider IN ('wave','orange_money','manual')),
  provider_ref    text,                       -- identifiant de session ou référence déclarée
  checkout_url    text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','failed','expired','refund_requested','refunded')),
  refund_approvals jsonb NOT NULL DEFAULT '[]', -- double validation : finance puis administrateur
  confirmed_by    uuid REFERENCES users(id),
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON payments (status, created_at DESC);
CREATE INDEX ON payments (user_id, created_at DESC);
ALTER TABLE subscriptions ADD COLUMN payment_id uuid REFERENCES payments(id);

-- ---------- Crédits SM-IA ----------
CREATE TABLE credit_wallets (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance    int NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credit_ledger (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta         int  NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('grant_trial','grant_subscription','recharge','usage','adjust')),
  payment_id    uuid REFERENCES payments(id),
  ai_call_id    uuid,
  note          text,
  balance_after int  NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON credit_ledger (user_id, created_at DESC);

CREATE TABLE ai_settings (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT true,    -- coupure individuelle
  autonomy        int     NOT NULL DEFAULT 1 CHECK (autonomy BETWEEN 1 AND 3),
  daily_credit_cap int    NOT NULL DEFAULT 120 CHECK (daily_credit_cap >= 0),
  min_balance_stop int    NOT NULL DEFAULT 100 CHECK (min_balance_stop >= 0),
  chatbot_enabled boolean NOT NULL DEFAULT false,   -- SM-IA Commandes
  chatbot_mode    text    NOT NULL DEFAULT 'offline' CHECK (chatbot_mode IN ('offline','always')),
  perm_answer     boolean NOT NULL DEFAULT true,
  perm_accept     boolean NOT NULL DEFAULT true,
  perm_meeting    boolean NOT NULL DEFAULT true,
  max_order_fcfa  int     NOT NULL DEFAULT 50000,
  meeting_info    text,                              -- créneaux et lieux de remise du commerçant
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Chaque appel au modèle : tokens, coût réel, crédits débités
CREATE TABLE ai_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,  -- NULL = payé par la plateforme
  feature       text NOT NULL,
  model         text NOT NULL,
  input_tokens  int  NOT NULL DEFAULT 0,
  output_tokens int  NOT NULL DEFAULT 0,
  cache_read_tokens  int NOT NULL DEFAULT 0,
  cache_write_tokens int NOT NULL DEFAULT 0,
  cost_usd      numeric(12,6) NOT NULL DEFAULT 0,
  credits       int  NOT NULL DEFAULT 0,
  ok            boolean NOT NULL DEFAULT true,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ai_calls (user_id, created_at DESC);
CREATE INDEX ON ai_calls (created_at DESC);

-- Journal des actions de SM-IA, y compris les propositions en attente d'accord
CREATE TABLE ai_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (source IN ('chatbot','assistant','moderation','kyc_precheck')),
  kind            text NOT NULL,
  status          text NOT NULL CHECK (status IN ('done','pending','approved','rejected','blocked','flagged','advice')),
  summary         text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  credits         int  NOT NULL DEFAULT 0,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  order_id        uuid REFERENCES orders(id) ON DELETE SET NULL,
  listing_id      uuid REFERENCES listings(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ai_actions (user_id, created_at DESC);
CREATE INDEX ON ai_actions (status, created_at DESC);

CREATE TABLE ai_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user','assistant')),
  content    text NOT NULL,
  credits    int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ai_messages (user_id, created_at);

ALTER TABLE verifications ADD COLUMN ai_precheck jsonb;

-- ---------- Visibilité payante : mise en avant, campagnes, publicité ----------
CREATE TABLE promotions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('featured','campaign','ad')),
  listing_id  uuid REFERENCES listings(id) ON DELETE CASCADE,
  placement   text NOT NULL DEFAULT 'search_top' CHECK (placement IN ('search_top','home','category')),
  category_id int REFERENCES categories(id),
  quarter     text,                                -- ciblage (publicité)
  promo_price_fcfa int,                            -- prix promotionnel (campagne)
  title       text,
  image_url   text,
  days        int  NOT NULL CHECK (days BETWEEN 1 AND 60),
  starts_at   timestamptz,
  ends_at     timestamptz,
  status      text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','active','ended','cancelled')),
  payment_id  uuid REFERENCES payments(id),
  impressions int  NOT NULL DEFAULT 0,
  clicks      int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON promotions (kind, status, ends_at);

-- ---------- Préférences de notification ----------
CREATE TABLE notification_prefs (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs      jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Signalements : versions des parties, preuves, délai ----------
ALTER TABLE reports ALTER COLUMN reporter_id DROP NOT NULL;   -- NULL = signalement automatique (modération)
ALTER TABLE reports ADD COLUMN reported_user_id uuid REFERENCES users(id);
ALTER TABLE reports ADD COLUMN due_at timestamptz NOT NULL DEFAULT now() + interval '72 hours';
ALTER TABLE reports ADD COLUMN decision_note text;
CREATE TABLE report_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id  uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES users(id),
  party      text NOT NULL CHECK (party IN ('reporter','reported','staff')),
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE report_evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  uploader_id uuid NOT NULL REFERENCES users(id),
  file        text NOT NULL,                       -- stockage privé
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Journal d'audit : empreinte chaînée ----------
-- SHA-256 intégré à PostgreSQL (11+), sans pgcrypto. convert_to(..., encodage de la base) donne exactement les octets
-- que hachait digest() de pgcrypto : les empreintes sont identiques.
ALTER TABLE audit_log ADD COLUMN prev_hash text;
ALTER TABLE audit_log ADD COLUMN hash text;
CREATE OR REPLACE FUNCTION audit_chain() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(424242);
  SELECT hash INTO NEW.prev_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.hash := encode(sha256(convert_to(coalesce(NEW.prev_hash, '') || '|' || NEW.id || '|' || coalesce(NEW.actor_id::text, '') || '|' || NEW.action
    || '|' || coalesce(NEW.target, '') || '|' || NEW.details::text || '|' || to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), getdatabaseencoding())), 'hex');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
ALTER TABLE audit_log DISABLE TRIGGER audit_append_only;
DO $$ DECLARE r record; prev text := NULL; h text; BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY id LOOP
    h := encode(sha256(convert_to(coalesce(prev, '') || '|' || r.id || '|' || coalesce(r.actor_id::text, '') || '|' || r.action || '|' || coalesce(r.target, '')
      || '|' || r.details::text || '|' || to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), getdatabaseencoding())), 'hex');
    UPDATE audit_log SET prev_hash = prev, hash = h WHERE id = r.id;
    prev := h;
  END LOOP;
END $$;
ALTER TABLE audit_log ENABLE TRIGGER audit_append_only;
CREATE TRIGGER audit_chain_before_insert BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_chain();

-- ---------- Paramètres ----------
-- « confirmed = false » : proposition à valider par l'équipe. Une valeur null désactive le service tant qu'aucun tarif n'est fixé.
INSERT INTO settings (key, value, confirmed) VALUES
  ('smia_enabled', 'true', true),
  ('smia_chatbot_enabled', 'true', true),
  ('smia_assistant_enabled', 'true', true),
  ('smia_moderation_enabled', 'false', false),
  ('smia_kyc_precheck_enabled', 'false', false),
  ('smia_model', '"claude-haiku-5-5"', false),
  ('smia_price_input_usd_mtok', '0.10', true),
  ('smia_price_output_usd_mtok', '0.50', true),
  ('usd_xof', '600', false),
  ('smia_credit_cost_usd', '0.0001', false),
  ('smia_credits_per_1000_fcfa', '4000', false),
  ('smia_recharge_packs_fcfa', '[2000, 5000, 10000]', false),
  ('smia_min_recharge_fcfa', '500', false),
  ('smia_trial_credits', '500', false),
  ('smia_subscription_credits', '2000', false),
  ('smia_max_order_fcfa', '50000', false),
  ('featured_price_per_day_fcfa', 'null', false),
  ('campaign_price_per_day_fcfa', 'null', false),
  ('ad_price_per_day_fcfa', 'null', false),
  ('refund_double_validation', 'true', true),
  ('prohibited_items', '["Alcool", "Médicaments", "Armes", "Produits contrefaits", "Animaux protégés"]', false),
  ('role_permissions', '{"moderator": ["verify", "moderate"], "finance": ["revenue", "export"], "support": ["moderate"]}', false)
ON CONFLICT (key) DO NOTHING;
DELETE FROM settings WHERE key = 'featured_price_fcfa';
