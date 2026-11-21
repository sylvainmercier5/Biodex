-- ============================================================================
-- BioDex — Sécurité, étape 1/2 : PROPRIÉTAIRES (sans rien casser)
-- ============================================================================
-- À passer AVANT de mettre en ligne la nouvelle version de l'appli.
-- Ne retire aucun droit : l'ancienne appli continue de fonctionner à l'identique.
--
-- Ce que ça fait :
--   1. Ajoute une colonne owner_id à chaque table où l'on écrit. Elle se remplit
--      toute seule avec l'identité Supabase de la personne (auth.uid()) — y compris
--      l'identité anonyme invisible que la nouvelle appli crée sur chaque téléphone.
--      Les lignes déjà existantes restent sans propriétaire (owner_id = null).
--   2. Empêche de « voler » une ligne en changeant son owner_id (déclencheur).
--   3. Crée les fonctions serveur qui remplacent les écritures de scores faites
--      jusqu'ici directement depuis le navigateur (ligue, arène, quiz).
--   4. Corrige les deux alertes de l'audit Supabase sur les fonctions.
-- ============================================================================

-- ── 1. Colonne propriétaire ─────────────────────────────────────────────────
alter table public.posts             add column if not exists owner_id uuid default auth.uid();
alter table public.idees             add column if not exists owner_id uuid default auth.uid();
alter table public.commentaires      add column if not exists owner_id uuid default auth.uid();
alter table public.cartes_ligue      add column if not exists owner_id uuid default auth.uid();
alter table public.missions_validees add column if not exists owner_id uuid default auth.uid();
alter table public.reactions_detail  add column if not exists owner_id uuid default auth.uid();
alter table public.profils           add column if not exists owner_id uuid default auth.uid();

create index if not exists posts_owner_id_idx        on public.posts (owner_id);
create index if not exists cartes_ligue_owner_id_idx on public.cartes_ligue (owner_id);

-- ── 2. Le propriétaire ne se change pas ─────────────────────────────────────
-- À l'insertion : la ligne appartient à qui l'écrit (impossible d'en fabriquer
-- une au nom de quelqu'un d'autre). À la modification : le propriétaire reste
-- le même ; une ligne ancienne sans propriétaire est attribuée à qui la modifie
-- (utile pour les profils, voir l'étape 2). L'admin garde la main.
create or replace function public.bd_garder_proprietaire()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.owner_id := auth.uid();
    end if;
  elsif tg_op = 'UPDATE' then
    if not public.est_admin() then
      new.owner_id := coalesce(old.owner_id, auth.uid());
    end if;
  end if;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['posts','idees','commentaires','cartes_ligue','missions_validees','reactions_detail','profils'] loop
    execute format('drop trigger if exists bd_garder_proprietaire on public.%I', t);
    execute format('create trigger bd_garder_proprietaire before insert or update on public.%I
                    for each row execute function public.bd_garder_proprietaire()', t);
  end loop;
end $$;

-- ── 3. Fonctions serveur pour les scores ────────────────────────────────────
-- Jusqu'ici, le navigateur modifiait directement les compteurs (y compris ceux
-- des AUTRES joueurs). Désormais il passe par ces fonctions, qui ne font
-- qu'ajouter +1 victoire/défaite ou monter un record : impossible d'effacer
-- ou de réécrire les scores de quelqu'un.

-- Résultat d'un défi de ligue : met à jour la carte défendue, la carte du
-- défieur (si elle est engagée), les scores des deux joueurs et l'historique.
create or replace function public.enregistrer_defi(
  p_carte_defendue uuid,
  p_defieur        text,
  p_defieur_gagne  boolean,
  p_carte_defieur  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c     public.cartes_ligue%rowtype;
  v_def text := left(coalesce(nullif(trim(p_defieur), ''), '?'), 40);
  g     boolean := coalesce(p_defieur_gagne, false);
begin
  if auth.uid() is null then
    raise exception 'Connexion requise';
  end if;

  select * into c from public.cartes_ligue where id = p_carte_defendue;
  if not found then
    raise exception 'Carte introuvable';
  end if;

  -- Carte défendue : +1 V ou +1 D, et de l'XP (elle progresse même en perdant)
  update public.cartes_ligue
     set victoires = victoires + case when g then 0 else 1 end,
         defaites  = defaites  + case when g then 1 else 0 end,
         xp        = xp        + case when g then 4 else 10 end
   where id = c.id;

  -- Carte du défieur : seulement la sienne (ou une ancienne sans propriétaire)
  if p_carte_defieur is not null then
    update public.cartes_ligue
       set victoires = victoires + case when g then 1 else 0 end,
           defaites  = defaites  + case when g then 0 else 1 end
     where proprietaire = v_def
       and carte_id = p_carte_defieur
       and (owner_id = auth.uid() or owner_id is null);
  end if;

  -- Scores des deux joueurs
  insert into public.ligue_scores as s (proprietaire, victoires, defaites, maj)
  values (v_def, case when g then 1 else 0 end, case when g then 0 else 1 end, now())
  on conflict (proprietaire) do update
     set victoires = s.victoires + excluded.victoires,
         defaites  = s.defaites  + excluded.defaites,
         maj       = now();

  insert into public.ligue_scores as s (proprietaire, victoires, defaites, maj)
  values (left(coalesce(c.proprietaire, '?'), 40), case when g then 0 else 1 end, case when g then 1 else 0 end, now())
  on conflict (proprietaire) do update
     set victoires = s.victoires + excluded.victoires,
         defaites  = s.defaites  + excluded.defaites,
         maj       = now();

  -- Historique (notifications « X a défié ta carte »)
  insert into public.defis_historique (defieur, defendeur, carte_nom, defieur_gagne)
  values (v_def, left(coalesce(c.proprietaire, '?'), 40), left(coalesce(c.nom, 'ta carte'), 120), g);
end;
$$;

-- Record d'arène : ne fait que monter.
create or replace function public.enregistrer_record_arene(p_prenom text, p_record integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_p text := left(trim(coalesce(p_prenom, '')), 40);
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if v_p = '' or p_record is null or p_record <= 0 then return; end if;
  insert into public.ligue_scores as s (proprietaire, record_arene, maj)
  values (v_p, least(p_record, 100000), now())
  on conflict (proprietaire) do update
     set record_arene = greatest(coalesce(s.record_arene, 0), excluded.record_arene),
         maj = now();
end;
$$;

-- Score cumulé du quiz : ne fait que monter.
create or replace function public.enregistrer_score_quiz(p_joueur text, p_total integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_j text := left(trim(coalesce(p_joueur, '')), 40);
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if v_j = '' or p_total is null or p_total < 0 then return; end if;
  insert into public.quiz_scores as q (joueur, total, maj)
  values (v_j, least(p_total, 1000000), now())
  on conflict (joueur) do update
     set total = greatest(q.total, excluded.total),
         maj = now();
end;
$$;

-- Seules les personnes ayant une identité (même anonyme) peuvent les appeler.
revoke all on function public.enregistrer_defi(uuid, text, boolean, text) from public, anon;
revoke all on function public.enregistrer_record_arene(text, integer)      from public, anon;
revoke all on function public.enregistrer_score_quiz(text, integer)        from public, anon;
grant execute on function public.enregistrer_defi(uuid, text, boolean, text) to authenticated;
grant execute on function public.enregistrer_record_arene(text, integer)      to authenticated;
grant execute on function public.enregistrer_score_quiz(text, integer)        to authenticated;

-- ── 4. Alertes de l'audit Supabase ──────────────────────────────────────────
-- est_admin : chemin de recherche figé (alerte « search_path mutable »).
create or replace function public.est_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where email = auth.jwt() ->> 'email'
  );
$$;

-- incrementer_reaction : vestige d'une ancienne version, plus utilisé par
-- l'appli, mais appelable par n'importe qui. On ferme.
alter function public.incrementer_reaction(bigint, text) set search_path = public;
revoke all on function public.incrementer_reaction(bigint, text) from public, anon, authenticated;
