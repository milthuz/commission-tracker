-- 005 — Ouvrir le programme La Passe (pass_config.enabled = true).
--
-- Demandé par David pour voir les écrans membres avec de vraies données : tant que le
-- drapeau est faux, les endpoints répondent `program_not_open`.
--
-- La ligne `pass_config` N'EXISTE PAS encore : la configuration tourne entièrement sur
-- PASS_CONFIG_DEFAULTS (server.js). Comme getPassConfig() fait une fusion SUPERFICIELLE
-- avec ces défauts, écrire le seul drapeau suffit — tout le reste (paliers, devise, pays,
-- rabais matériel) continue de venir du code. Y recopier l'échelle la figerait à ce que ce
-- fichier connaît aujourd'hui, et elle divergerait au premier changement de défaut.
--
-- `value` est de type jsonb. Réversible : rejouer avec 'false' referme le programme.

BEGIN;

DO $$
DECLARE recipients text;
BEGIN
  RAISE NOTICE 'pass_config AVANT : %',
    COALESCE((SELECT value::text FROM app_settings WHERE key = 'pass_config'), '(absent — defauts du code)');

  -- Liste vide = un crédit accordé n'avertit PERSONNE et le marchand n'est jamais payé.
  -- Mieux vaut le lire ici qu'au premier crédit.
  SELECT value::text INTO recipients FROM app_settings WHERE key = 'pass_credit_recipients';
  RAISE NOTICE 'destinataires de l''avis comptable : %', COALESCE(recipients, '(AUCUN — a configurer)');
END $$;

INSERT INTO app_settings (key, value, updated_at)
VALUES ('pass_config', '{"enabled": true}'::jsonb, NOW())
ON CONFLICT (key) DO UPDATE
   SET value = jsonb_set(app_settings.value, '{enabled}', 'true'::jsonb),
       updated_at = NOW();

DO $$
BEGIN
  RAISE NOTICE 'pass_config APRES : %',
    COALESCE((SELECT value::text FROM app_settings WHERE key = 'pass_config'), '(absent — rien mis a jour)');
END $$;

COMMIT;
