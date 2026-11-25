-- Journal d'audit sans l'extension pgcrypto (indisponible sur PlanetHoster N0C).
-- Pour les bases où la migration 002 a déjà installé l'ancienne fonction (avec digest() de pgcrypto) :
-- même calcul, mêmes champs, même format, avec le SHA-256 intégré à PostgreSQL (11+).
-- convert_to(..., encodage de la base) fournit exactement les octets que hachait digest() :
-- les empreintes existantes restent valides. Aucune donnée n'est modifiée. Rejouable sans risque.
CREATE OR REPLACE FUNCTION audit_chain() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(424242);
  SELECT hash INTO NEW.prev_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.hash := encode(sha256(convert_to(coalesce(NEW.prev_hash, '') || '|' || NEW.id || '|' || coalesce(NEW.actor_id::text, '') || '|' || NEW.action
    || '|' || coalesce(NEW.target, '') || '|' || NEW.details::text || '|' || to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    getdatabaseencoding())), 'hex');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
