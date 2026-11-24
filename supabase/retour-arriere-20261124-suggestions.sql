-- Retour arrière de migrations/20261124_suggestions.sql
-- ATTENTION : supprime toutes les suggestions (et leur historique). Les noms déjà
-- corrigés dans posts restent corrigés.
drop function if exists public.goupil_retirer_suggestion(text, bigint);
drop function if exists public.goupil_suivre_suggestions(text, bigint[]);
drop function if exists public.goupil_deposer_suggestion(text, bigint, text, text, text, text, text, text);
drop function if exists public.repondre_suggestion(bigint, text);
drop function if exists public.marquer_suggestion_vue(bigint);
drop table if exists public.suggestions;
drop function if exists private.goupil_jeton_valide(text);
drop table if exists private.goupil_jetons;
drop schema if exists private;
