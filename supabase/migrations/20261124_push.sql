-- ============================================================================
-- BioDex — Notifications push (v1.95)
-- ============================================================================
-- • public.push_abonnements : un abonnement Web Push par téléphone (endpoint),
--   rattaché à l'identité Supabase. Aucun accès direct : deux fonctions
--   (push_enregistrer, push_supprimer) pour le propriétaire.
-- • public.push_journal : dédoublonnage des envois (une notification par
--   événement). Lisible par personne ; seule la fonction d'envoi (service_role) y écrit.
-- • Déclencheurs : un nouvel événement (suggestion, commentaire, réaction, défi,
--   publication) prévient la fonction Edge « notifier » par pg_net, sans rien
--   transmettre d'autre que (table, id). La fonction relit la ligne elle-même.
--   Un échec d'appel ne bloque JAMAIS l'insertion d'origine.
-- Retour arrière : ../retour-arriere-20261124-push.sql
-- ============================================================================

create extension if not exists pg_net;

create table public.push_abonnements (
  id bigint generated always as identity primary key,
  cree timestamptz not null default now(),
  owner_id uuid not null,
  endpoint text not null unique check (endpoint like 'https://%' and char_length(endpoint) <= 1000),
  p256dh text not null check (char_length(p256dh) <= 200),
  auth text not null check (char_length(auth) <= 100),
  prefs jsonb not null default '{"suggestions": true, "commentaires": true, "reactions": true, "defis": true, "mur": false}'::jsonb,
  appareil text check (appareil is null or char_length(appareil) <= 200)
);
create index push_abonnements_owner on public.push_abonnements (owner_id);
alter table public.push_abonnements enable row level security;
revoke all on public.push_abonnements from public, anon, authenticated;

create table public.push_journal (
  cle text primary key,
  cree timestamptz not null default now()
);
alter table public.push_journal enable row level security;
revoke all on public.push_journal from public, anon, authenticated;

-- ---------- Fonctions pour l'appli ----------
-- Enregistre (ou met à jour) l'abonnement de CE téléphone pour l'identité connectée.
create or replace function public.push_enregistrer(p_endpoint text, p_p256dh text, p_auth text, p_prefs jsonb, p_appareil text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare moi uuid := auth.uid();
begin
  if moi is null then return jsonb_build_object('ok', false, 'raison', 'identite'); end if;
  if p_endpoint is null or p_endpoint not like 'https://%' then return jsonb_build_object('ok', false, 'raison', 'endpoint'); end if;
  insert into public.push_abonnements (owner_id, endpoint, p256dh, auth, prefs, appareil)
  values (moi, p_endpoint, p_p256dh, p_auth,
          coalesce(p_prefs, '{"suggestions": true, "commentaires": true, "reactions": true, "defis": true, "mur": false}'::jsonb),
          left(p_appareil, 200))
  on conflict (endpoint) do update
    set owner_id = excluded.owner_id, p256dh = excluded.p256dh, auth = excluded.auth,
        prefs = excluded.prefs, appareil = excluded.appareil;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.push_supprimer(p_endpoint text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from public.push_abonnements where endpoint = p_endpoint and owner_id = auth.uid();
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n > 0);
end;
$$;

revoke all on function public.push_enregistrer(text, text, text, jsonb, text) from public, anon;
revoke all on function public.push_supprimer(text) from public, anon;
grant execute on function public.push_enregistrer(text, text, text, jsonb, text) to authenticated;
grant execute on function public.push_supprimer(text) to authenticated;

-- ---------- Déclencheurs ----------
create or replace function public.bd_push_prevenir()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform net.http_post(
      url := 'https://vnoagcaaeqzwnfylmqvn.supabase.co/functions/v1/notifier',
      body := jsonb_build_object('table', tg_table_name, 'id', new.id::text),
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 5000
    );
  exception when others then
    null; -- une notification manquée ne doit jamais empêcher la publication
  end;
  return new;
end;
$$;
revoke all on function public.bd_push_prevenir() from public, anon, authenticated;

create trigger bd_push_suggestions after insert on public.suggestions for each row execute function public.bd_push_prevenir();
create trigger bd_push_commentaires after insert on public.commentaires for each row execute function public.bd_push_prevenir();
create trigger bd_push_reactions after insert on public.reactions_detail for each row execute function public.bd_push_prevenir();
create trigger bd_push_defis after insert on public.defis_historique for each row execute function public.bd_push_prevenir();
create trigger bd_push_posts after insert on public.posts for each row execute function public.bd_push_prevenir();
