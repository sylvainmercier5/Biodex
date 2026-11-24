-- ============================================================================
-- BioDex — Suggestions du relecteur Goupil (APPLIQUÉE le 24/11/2026 : suggestions_relecteur_20261124)
-- ============================================================================
-- Contrat : C:\Goupil\goupil\conception\biodex\suggestions-contrat.md
--
-- • public.suggestions : lisible seulement par l'auteur du post (et les admins),
--   aucune écriture directe : tout passe par les fonctions ci-dessous.
-- • Auteur (authenticated) : marquer_suggestion_vue, repondre_suggestion.
-- • Goupil (anon + jeton) : goupil_deposer_suggestion, goupil_suivre_suggestions,
--   goupil_retirer_suggestion. La base ne garde que l'empreinte SHA-256 du jeton,
--   dans le schéma private (non exposé par l'API). Couper Goupil :
--     delete from private.goupil_jetons;
--
-- Retour arrière : ../retour-arriere-20261124-suggestions.sql
-- ============================================================================

-- ---------- Jetons Goupil (schéma privé) ----------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.goupil_jetons (
  empreinte text primary key,
  cree timestamptz not null default now()
);
revoke all on private.goupil_jetons from public, anon, authenticated;

insert into private.goupil_jetons (empreinte)
values ('4dfbdd1fe2cd1d4ab3f43168962bcec8f95d60840d810eb761d371d939a665df')
on conflict do nothing;

create or replace function private.goupil_jeton_valide(p_jeton text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_jeton is not null and length(p_jeton) between 16 and 512
     and exists (select 1 from private.goupil_jetons j
                  where j.empreinte = encode(extensions.digest(p_jeton, 'sha256'), 'hex'));
$$;
revoke all on function private.goupil_jeton_valide(text) from public, anon, authenticated;

-- ---------- Table des suggestions ----------
create table public.suggestions (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  post_id bigint not null references public.posts(id) on delete cascade,
  owner_id uuid not null,
  annonce text,
  annonce_sci text,
  texte text not null check (char_length(texte) between 1 and 600),
  propose_rang text not null check (propose_rang in ('espece', 'famille', 'ordre')),
  propose_sci text not null check (char_length(propose_sci) between 1 and 120),
  propose_fr text check (propose_fr is null or char_length(propose_fr) <= 120),
  propose_famille text check (propose_famille is null or char_length(propose_famille) <= 120),
  propose_ordre text check (propose_ordre is null or char_length(propose_ordre) <= 120),
  statut text not null default 'envoyee' check (statut in ('envoyee', 'vue', 'acceptee', 'refusee', 'retiree')),
  vue_le timestamptz,
  repondu_le timestamptz,
  source text not null default 'goupil'
);
-- Une seule suggestion active par observation.
create unique index suggestions_une_active on public.suggestions (post_id) where statut <> 'retiree';
create index suggestions_owner on public.suggestions (owner_id);

alter table public.suggestions enable row level security;
revoke all on public.suggestions from public, anon, authenticated;
grant select on public.suggestions to authenticated;
create policy suggestions_lecture on public.suggestions for select to authenticated
  using (owner_id = (select auth.uid()) or (select public.est_admin()));

-- ---------- Fonctions pour l'auteur ----------
create or replace function public.marquer_suggestion_vue(p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.suggestions set statut = 'vue', vue_le = now()
   where id = p_id and owner_id = auth.uid() and statut = 'envoyee';
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n = 1);
end;
$$;

create or replace function public.repondre_suggestion(p_id bigint, p_reponse text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.suggestions%rowtype;
begin
  if p_reponse not in ('acceptee', 'refusee') then
    return jsonb_build_object('ok', false, 'raison', 'reponse');
  end if;
  select * into s from public.suggestions
   where id = p_id and owner_id = auth.uid() and statut in ('envoyee', 'vue')
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'raison', 'introuvable');
  end if;
  update public.suggestions
     set statut = p_reponse, repondu_le = now(), vue_le = coalesce(vue_le, now())
   where id = s.id;
  -- Espèce acceptée : le post prend le nouveau nom dans la même transaction.
  -- (Famille ou ordre : rien ne change, l'appli ouvre la fiche pour que l'auteur choisisse.)
  if p_reponse = 'acceptee' and s.propose_rang = 'espece' then
    update public.posts
       set espece_sci = s.propose_sci,
           espece = coalesce(nullif(s.propose_fr, ''), espece)
     where id = s.post_id;
  end if;
  return jsonb_build_object('ok', true, 'statut', p_reponse, 'rang', s.propose_rang,
                            'post_id', s.post_id, 'propose_sci', s.propose_sci, 'propose_fr', s.propose_fr);
end;
$$;

revoke all on function public.marquer_suggestion_vue(bigint) from public, anon;
revoke all on function public.repondre_suggestion(bigint, text) from public, anon;
grant execute on function public.marquer_suggestion_vue(bigint) to authenticated;
grant execute on function public.repondre_suggestion(bigint, text) to authenticated;

-- ---------- Fonctions pour Goupil (jeton) ----------
create or replace function public.goupil_deposer_suggestion(
  p_jeton text, p_post_id bigint, p_texte text, p_rang text,
  p_sci text, p_fr text, p_famille text, p_ordre text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.posts%rowtype; nouvel bigint;
begin
  if not private.goupil_jeton_valide(p_jeton) then
    return jsonb_build_object('ok', false, 'raison', 'jeton');
  end if;
  select * into p from public.posts where id = p_post_id;
  if not found then return jsonb_build_object('ok', false, 'raison', 'post_absent'); end if;
  if p.owner_id is null then return jsonb_build_object('ok', false, 'raison', 'sans_proprietaire'); end if;
  if exists (select 1 from public.suggestions where post_id = p_post_id and statut <> 'retiree') then
    return jsonb_build_object('ok', false, 'raison', 'deja_suggere');
  end if;
  if coalesce(btrim(p_texte), '') = '' or char_length(p_texte) > 600 then
    return jsonb_build_object('ok', false, 'raison', 'texte');
  end if;
  if p_rang not in ('espece', 'famille', 'ordre') or coalesce(btrim(p_sci), '') = '' then
    return jsonb_build_object('ok', false, 'raison', 'proposition');
  end if;
  insert into public.suggestions (post_id, owner_id, annonce, annonce_sci, texte, propose_rang,
                                  propose_sci, propose_fr, propose_famille, propose_ordre)
  values (p.id, p.owner_id, p.espece, p.espece_sci, p_texte, p_rang,
          btrim(p_sci), nullif(btrim(p_fr), ''), nullif(btrim(p_famille), ''), nullif(btrim(p_ordre), ''))
  returning id into nouvel;
  return jsonb_build_object('ok', true, 'id', nouvel);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'raison', 'deja_suggere');
end;
$$;

-- Jeton invalide : aucune ligne (une fonction « table » ne peut pas rendre le jsonb d'erreur).
create or replace function public.goupil_suivre_suggestions(p_jeton text, p_ids bigint[])
returns table (id bigint, statut text, vue_le timestamptz, repondu_le timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.id, s.statut, s.vue_le, s.repondu_le
    from public.suggestions s
   where private.goupil_jeton_valide(p_jeton)
     and s.source = 'goupil'
     and s.id = any (coalesce(p_ids, '{}'::bigint[]))
   limit 1000;
$$;

create or replace function public.goupil_retirer_suggestion(p_jeton text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not private.goupil_jeton_valide(p_jeton) then
    return jsonb_build_object('ok', false, 'raison', 'jeton');
  end if;
  update public.suggestions set statut = 'retiree'
   where id = p_id and source = 'goupil' and statut in ('envoyee', 'vue');
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('ok', false, 'raison', 'introuvable'); end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.goupil_deposer_suggestion(text, bigint, text, text, text, text, text, text) from public;
revoke all on function public.goupil_suivre_suggestions(text, bigint[]) from public;
revoke all on function public.goupil_retirer_suggestion(text, bigint) from public;
grant execute on function public.goupil_deposer_suggestion(text, bigint, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.goupil_suivre_suggestions(text, bigint[]) to anon, authenticated;
grant execute on function public.goupil_retirer_suggestion(text, bigint) to anon, authenticated;
