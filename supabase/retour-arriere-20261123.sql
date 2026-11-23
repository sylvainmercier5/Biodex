-- ============================================================================
-- BioDex : RETOUR ARRIÈRE de securite.sql
-- Remet exactement les politiques, fonctions et droits relevés le 23 novembre
-- 2026 (avant correction). ATTENTION : ça rouvre les trous (n'importe qui peut
-- de nouveau modifier / supprimer posts et photos). À n'utiliser que si
-- l'appli est cassée et qu'on n'a pas d'autre solution dans l'heure.
--
-- Les données écrites entre-temps ne sont PAS touchées, sauf le rattachement
-- des anciennes publications (section C de securite.sql), défait ici : toutes
-- les lignes d'avant le 21 novembre étaient sans propriétaire.
-- À passer d'un bloc dans Supabase → SQL Editor.
-- ============================================================================

begin;

-- ── Fonctions : définitions d'origine ──────────────────────────────────────
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
-- Droits d'origine : PUBLIC, anon, authenticated, service_role.
grant execute on function public.est_admin() to public, anon, authenticated, service_role;

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
-- (enregistrer_defi / _record_arene / _score_quiz : droits inchangés par
--  securite.sql, rien à remettre.)

-- ── Défaire le rattachement des anciennes publications ─────────────────────
alter table public.posts        disable trigger bd_garder_proprietaire;
alter table public.cartes_ligue disable trigger bd_garder_proprietaire;
update public.posts        set owner_id = null where created_at < timestamptz '2026-11-21' and owner_id is not null;
update public.cartes_ligue set owner_id = null where created_at < timestamptz '2026-11-21' and owner_id is not null;
alter table public.posts        enable trigger bd_garder_proprietaire;
alter table public.cartes_ligue enable trigger bd_garder_proprietaire;

-- ── Droits de table d'origine ───────────────────────────────────────────────
revoke update (espece, espece_sci, lieu, note) on public.posts from authenticated;
grant  update on public.posts to authenticated;
revoke update (xp) on public.cartes_ligue from authenticated;
grant  update on public.cartes_ligue to anon, authenticated;

grant insert, update, delete, truncate on
  public.posts, public.idees, public.commentaires, public.cartes_ligue,
  public.ligue_scores, public.missions_validees, public.reactions_detail,
  public.reactions, public.profils, public.quiz_scores, public.defis_historique,
  public.satisfaction, public.collections, public.admins, public.ia_budget
  to anon, authenticated;

-- ── Politiques : on retire tout, on remet l'existant à l'identique ─────────
do $$
declare r record;
begin
  for r in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('posts','idees','commentaires','cartes_ligue','ligue_scores',
                        'missions_validees','reactions_detail','reactions','profils',
                        'quiz_scores','defis_historique','satisfaction','collections',
                        'admins')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- admins
create policy admins_lecture_de_soi on public.admins
  for select to public using (email = (auth.jwt() ->> 'email'));

-- cartes_ligue
create policy cartes_ligue_suppression_admin on public.cartes_ligue
  for delete to public using (public.est_admin());
create policy ligue_delete on public.cartes_ligue
  for delete to anon, authenticated using (true);
create policy ligue_insert on public.cartes_ligue
  for insert to anon, authenticated with check (true);
create policy ligue_lecture on public.cartes_ligue
  for select to anon, authenticated using (true);
create policy ligue_update on public.cartes_ligue
  for update to anon, authenticated using (true);

-- collections
create policy "Suppression de ses propres entrées" on public.collections
  for delete to authenticated using (auth.uid() = user_id);
create policy "Ajout de ses propres entrées" on public.collections
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Lecture publique des collections" on public.collections
  for select to anon, authenticated using (true);

-- commentaires
create policy commentaires_suppression_admin on public.commentaires
  for delete to public
  using (exists (select 1 from public.admins a where a.email = (auth.jwt() ->> 'email')));
create policy commentaires_insertion on public.commentaires
  for insert to public with check (true);
create policy commentaires_lecture on public.commentaires
  for select to public using (true);

-- defis_historique
create policy defis_hist_suppression_admin on public.defis_historique
  for delete to public
  using (exists (select 1 from public.admins a where a.email = (auth.jwt() ->> 'email')));
create policy defis_hist_insertion on public.defis_historique
  for insert to public with check (true);
create policy defis_hist_lecture on public.defis_historique
  for select to public using (true);

-- idees
create policy idees_suppression on public.idees
  for delete to anon, authenticated using (true);
create policy idees_suppression_admin on public.idees
  for delete to public using (public.est_admin());
create policy idees_insertion on public.idees
  for insert to anon, authenticated with check (true);
create policy idees_lecture on public.idees
  for select to anon, authenticated using (true);

-- ligue_scores
create policy scores_insert on public.ligue_scores
  for insert to anon, authenticated with check (true);
create policy scores_lecture on public.ligue_scores
  for select to anon, authenticated using (true);
create policy scores_update on public.ligue_scores
  for update to anon, authenticated using (true);

-- missions_validees
create policy missions_suppression on public.missions_validees
  for delete to anon, authenticated using (true);
create policy missions_insertion on public.missions_validees
  for insert to anon, authenticated with check (true);
create policy missions_lecture on public.missions_validees
  for select to anon, authenticated using (true);

-- posts
create policy posts_suppression on public.posts
  for delete to anon, authenticated using (true);
create policy posts_suppression_admin on public.posts
  for delete to public using (public.est_admin());
create policy "Ecriture publique des posts" on public.posts
  for insert to anon with check (true);
create policy posts_insertion on public.posts
  for insert to anon, authenticated with check (true);
create policy posts_lecture on public.posts
  for select to anon, authenticated using (true);
create policy posts_modification on public.posts
  for update to public using (true) with check (true);

-- profils
create policy profils_ecriture on public.profils
  for insert to public with check (true);
create policy profils_lecture on public.profils
  for select to public using (true);
create policy profils_maj on public.profils
  for update to public using (true);

-- quiz_scores
create policy quiz_suppression_admin on public.quiz_scores
  for delete to public
  using (exists (select 1 from public.admins a where a.email = (auth.jwt() ->> 'email')));
create policy quiz_insertion on public.quiz_scores
  for insert to public with check (true);
create policy quiz_lecture on public.quiz_scores
  for select to public using (true);
create policy quiz_maj on public.quiz_scores
  for update to public using (true) with check (true);

-- reactions (ancienne table)
create policy reactions_insertion on public.reactions
  for insert to anon, authenticated with check (true);
create policy reactions_lecture on public.reactions
  for select to anon, authenticated using (true);
create policy reactions_maj on public.reactions
  for update to anon, authenticated using (true) with check (true);

-- reactions_detail
create policy "reactions_detail ouvert" on public.reactions_detail
  for all to public using (true) with check (true);

-- satisfaction
create policy satisfaction_suppression_admin on public.satisfaction
  for delete to public
  using (exists (select 1 from public.admins a where a.email = (auth.jwt() ->> 'email')));
create policy satisfaction_insertion on public.satisfaction
  for insert to public with check (true);
create policy satisfaction_lecture_admin on public.satisfaction
  for select to public
  using (exists (select 1 from public.admins a where a.email = (auth.jwt() ->> 'email')));

-- ── Storage : politiques d'origine (« Lecture publique des photos » n'a pas
--    été touchée) ──────────────────────────────────────────────────────────
drop policy if exists "Envoi de photos (identité requise)" on storage.objects;
drop policy if exists "Suppression de ses photos"          on storage.objects;
drop policy if exists "Envoi de photos par tous"           on storage.objects;
drop policy if exists "Suppression de photos par tous"     on storage.objects;
create policy "Envoi de photos par tous" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'photos');
create policy "Suppression de photos par tous" on storage.objects
  for delete to anon, authenticated using (bucket_id = 'photos');

-- ── Index ajouté ────────────────────────────────────────────────────────────
drop index if exists public.collections_user_id_idx;

commit;
