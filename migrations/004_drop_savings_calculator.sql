-- 004 — Suppression définitive des tables du calculateur d'économies.
--
-- Le calculateur a été retiré du code le 2026-08-03 (commits « revert: retirer le
-- calculateur d'économies »). Les tables avaient été laissées en place par prudence ;
-- suppression demandée ensuite, les analyses enregistrées n'étant pas nécessaires.
--
-- ⚠️ IRRÉVERSIBLE. Contrairement au code, rien ici ne se récupère par un git revert.
-- Le bloc ci-dessous annonce donc ce qu'il détruit AVANT de le détruire : si le nombre
-- de lignes ne correspond pas à ce qu'on attend, on interrompt (Ctrl-C) — la
-- transaction n'a encore rien validé.

BEGIN;

DO $$
DECLARE
  n_tpl   int := 0;
  n_assig int := 0;
  n_anal  int := 0;
BEGIN
  IF to_regclass('public.pricing_templates') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM pricing_templates' INTO n_tpl;
  END IF;
  IF to_regclass('public.pricing_template_assignments') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM pricing_template_assignments' INTO n_assig;
  END IF;
  IF to_regclass('public.savings_analyses') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM savings_analyses' INTO n_anal;
  END IF;

  RAISE NOTICE 'A supprimer — grilles tarifaires : %, affectations aux reps : %, analyses enregistrees : %',
    n_tpl, n_assig, n_anal;
END $$;

-- Ordre imposé par la clé étrangère : les affectations pointent vers les grilles.
-- DROP explicite plutôt que CASCADE : si un objet inconnu dépendait de ces tables, on
-- veut une erreur qui nous arrête, pas une suppression silencieuse de cet objet-là.
DROP TABLE IF EXISTS pricing_template_assignments;
DROP TABLE IF EXISTS savings_analyses;
DROP TABLE IF EXISTS pricing_templates;

COMMIT;
