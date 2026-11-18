-- Sunu-Market : schéma initial (v0.1)
-- Paiement direct entre membres : aucune table de paiement de commande.
-- Seuls les services de la plateforme (abonnement, mise en avant, crédits SM-IA) sont encaissés.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Membres ----------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name    text NOT NULL,
  last_name     text NOT NULL,
  phone         text NOT NULL UNIQUE,                -- format E.164 : +221XXXXXXXXX
  password_hash text NOT NULL,
  quarter       text,                                -- quartier (ex. Médina, Parcelles Assainies)
  city          text NOT NULL DEFAULT 'Dakar',
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('member','moderator','admin')),
  -- La vérification est obligatoire : sans statut « verified », le compte ne peut rien faire.
  verification_status text NOT NULL DEFAULT 'unverified'
                CHECK (verification_status IN ('unverified','pending','verified','rejected')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  consent_at    timestamptz NOT NULL,               -- consentement loi n° 2008-12
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Dossiers de vérification. Les fichiers sont supprimés après la décision (minimisation des données).
CREATE TABLE verifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type     text NOT NULL CHECK (doc_type IN ('cni','passport','residence')),
  doc_file     text,                                 -- chemin privé, NULL après purge
  selfie_file  text,                                 -- chemin privé, NULL après purge
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reason       text,
  reviewer_id  uuid REFERENCES users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);
CREATE INDEX ON verifications (status, submitted_at);

-- ---------- Catalogue ----------
CREATE TABLE categories (
  id       serial PRIMARY KEY,
  slug     text NOT NULL UNIQUE,
  name     text NOT NULL,
  icon     text,
  position int  NOT NULL DEFAULT 0,
  is_shops boolean NOT NULL DEFAULT false            -- « Boutiques » mène aux boutiques, pas à des articles
);

CREATE TABLE subcategories (
  id          serial PRIMARY KEY,
  category_id int  NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  slug        text NOT NULL,
  name        text NOT NULL,
  items       text[] NOT NULL DEFAULT '{}',           -- exemples d'articles (niveau 3)
  source      text,                                   -- V, J, V+J, P
  position    int  NOT NULL DEFAULT 0,
  hidden      boolean NOT NULL DEFAULT false,
  UNIQUE (category_id, slug)
);

-- ---------- Boutiques et abonnement ----------
-- L'abonnement concerne uniquement les membres qui créent une boutique.
CREATE TABLE shops (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  quarter     text,
  city        text NOT NULL DEFAULT 'Dakar',
  universe    int REFERENCES categories(id),          -- univers principal (filtre « Par Univers »)
  banner      text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('trial','annual')),
  amount_fcfa int  NOT NULL DEFAULT 0,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('awaiting_payment','active','cancelled')),
  pay_method  text CHECK (pay_method IN ('wave','orange_money')),
  pay_ref     text,                                   -- référence de transaction déclarée
  confirmed_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON subscriptions (shop_id, ends_at DESC);

-- ---------- Annonces ----------
CREATE TABLE listings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  subcategory_id int  NOT NULL REFERENCES subcategories(id),
  title          text NOT NULL,
  description    text NOT NULL DEFAULT '',
  price_fcfa     int  NOT NULL CHECK (price_fcfa >= 0),
  condition      text NOT NULL CHECK (condition IN ('new','like_new','good','fair')),
  stock          int  NOT NULL DEFAULT 1 CHECK (stock >= 0),
  delivery       text[] NOT NULL DEFAULT '{hand}',    -- hand (remise en main propre), delivery, pickup
  pay_methods    text[] NOT NULL DEFAULT '{wave,orange_money,cash}',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','sold','removed')),
  featured_until timestamptz,                          -- mise en avant
  views          int  NOT NULL DEFAULT 0,
  search         tsvector GENERATED ALWAYS AS (to_tsvector('french', coalesce(title,'') || ' ' || coalesce(description,''))) STORED,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON listings USING gin (search);
CREATE INDEX ON listings (subcategory_id, status);
CREATE INDEX ON listings (shop_id);

CREATE TABLE listing_photos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  url        text NOT NULL,
  position   int  NOT NULL DEFAULT 0
);

CREATE TABLE favorites (
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  listing_id uuid REFERENCES listings(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, listing_id)
);

-- ---------- SM-Chat ----------
-- Les échanges se font dans l'application ; le paiement se conclut entre les deux membres.
CREATE TABLE conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid REFERENCES listings(id) ON DELETE SET NULL,
  buyer_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, buyer_id)
);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       uuid REFERENCES users(id) ON DELETE SET NULL,  -- NULL = message système
  kind            text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','system','order')),
  body            text NOT NULL,
  order_id        uuid,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON messages (conversation_id, created_at);

-- ---------- Commandes (sans paiement par la plateforme) ----------
CREATE SEQUENCE order_seq START 24000;
CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref             text NOT NULL UNIQUE DEFAULT ('SM-' || nextval('order_seq')::text),
  listing_id      uuid REFERENCES listings(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  buyer_id        uuid NOT NULL REFERENCES users(id),
  seller_id       uuid NOT NULL REFERENCES users(id),
  title_snapshot  text NOT NULL,
  unit_price_fcfa int  NOT NULL,
  quantity        int  NOT NULL DEFAULT 1 CHECK (quantity > 0),
  total_fcfa      int  NOT NULL,
  delivery_mode   text NOT NULL,
  pay_method      text NOT NULL,                      -- moyen convenu : wave, orange_money, cash
  meeting_place   text,
  meeting_at      timestamptz,
  status          text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','accepted','scheduled','completed','declined','cancelled')),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON orders (buyer_id, created_at DESC);
CREATE INDEX ON orders (seller_id, created_at DESC);

CREATE TABLE reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users(id),
  target_id   uuid NOT NULL REFERENCES users(id),
  rating      int  NOT NULL CHECK (rating BETWEEN 1 AND 5),
  tags        text[] NOT NULL DEFAULT '{}',
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, author_id)
);

-- ---------- Signalements ----------
CREATE SEQUENCE report_seq START 400;
CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref         text NOT NULL UNIQUE DEFAULT ('SR-' || lpad(nextval('report_seq')::text, 4, '0')),
  reporter_id uuid NOT NULL REFERENCES users(id),
  target_type text NOT NULL CHECK (target_type IN ('listing','user','order')),
  target_id   uuid NOT NULL,
  reason      text NOT NULL,
  details     text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  decision    text CHECK (decision IN ('dismiss','warn','remove','suspend')),
  decided_by  uuid REFERENCES users(id),
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Notifications ----------
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  title      text NOT NULL,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (user_id, created_at DESC);

-- ---------- Journal d'audit (ajout seul) ----------
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor_id   uuid REFERENCES users(id),
  action     text NOT NULL,
  target     text,
  details    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION audit_no_change() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log est en ajout seul'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_no_change();

-- ---------- Paramètres (tarifs décidés ou à confirmer) ----------
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  confirmed  boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value, confirmed) VALUES
  ('subscription_annual_fcfa', '2500', true),
  ('trial_days', '14', true),
  ('smia_recharge_commission_pct', '1', false),
  ('featured_price_fcfa', 'null', false);
