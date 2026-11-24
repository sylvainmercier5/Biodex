-- Retour arrière de migrations/20261124_push.sql (supprime les abonnements push)
drop trigger if exists bd_push_suggestions on public.suggestions;
drop trigger if exists bd_push_commentaires on public.commentaires;
drop trigger if exists bd_push_reactions on public.reactions_detail;
drop trigger if exists bd_push_defis on public.defis_historique;
drop trigger if exists bd_push_posts on public.posts;
drop function if exists public.bd_push_prevenir();
drop function if exists public.push_supprimer(text);
drop function if exists public.push_enregistrer(text, text, text, jsonb, text);
drop table if exists public.push_journal;
drop table if exists public.push_abonnements;
-- (l'extension pg_net est laissée en place : d'autres usages pourraient en dépendre)
