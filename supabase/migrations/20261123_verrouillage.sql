-- ============================================================================
-- BioDex — Sécurité, étape 2/2 : VERROUILLAGE (APPLIQUÉ le 23/11/2026)
-- ============================================================================
-- Copie exacte de la migration « securite_verrouillage_20261123 » telle qu'elle
-- a été passée sur la base (préparée depuis la session Goupil). Elle REMPLACE
-- l'ancien fichier 20261121_02_verrouillage.sql, retiré du dépôt.
--
-- Par rapport à l'étape 2 d'origine, elle :
--   • corrige le déclencheur de l'étape 1 : seule la table profils « adopte »
--     une ligne sans propriétaire (avant, défier une ancienne carte de ligue
--     la donnait au défieur) ;
--   • rend leurs anciennes publications aux auteurs dont la photo avait été
--     envoyée depuis un compte e-mail (284 posts, 8 cartes) ;
--   • passe est_admin() en SECURITY INVOKER, non appelable sans identité ;
--   • couvre satisfaction, collections et admins ;
--   • limite les colonnes modifiables (posts : 4 champs ; cartes : xp) ;
--   • n'accepte que des photos du bucket BioDex nommées post-…jpg / ligue-…jpg ;
--   • retire tout droit d'écriture au rôle anon ;
--   • écrit (select auth.uid()) pour les performances.
--
-- Retour arrière : ../retour-arriere-20261123.sql
-- Vérifié le 23/11/2026 : 14 gestes de la v1.80 simulés contre la base
-- verrouillée (transaction annulée), tous OK.
-- ============================================================================

create or replace function public.bd_garder_proprietaire()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.owner_id := auth.uid(); end if;
  elsif tg_op = 'UPDATE' then
    if not public.est_admin() then
      if tg_table_name = 'profils' then new.owner_id := coalesce(old.owner_id, auth.uid());
      else new.owner_id := old.owner_id; end if;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.est_admin()
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.admins a where a.email = (auth.jwt() ->> 'email'));
$$;
revoke all on function public.est_admin() from public, anon;
grant execute on function public.est_admin() to authenticated, service_role;

revoke all on function public.enregistrer_defi(uuid, text, boolean, text) from public, anon;
revoke all on function public.enregistrer_record_arene(text, integer) from public, anon;
revoke all on function public.enregistrer_score_quiz(text, integer) from public, anon;
grant execute on function public.enregistrer_defi(uuid, text, boolean, text) to authenticated;
grant execute on function public.enregistrer_record_arene(text, integer) to authenticated;
grant execute on function public.enregistrer_score_quiz(text, integer) to authenticated;

-- Anciennes publications rendues à leurs auteurs (photo envoyée depuis un compte e-mail)
alter table public.posts disable trigger bd_garder_proprietaire;
alter table public.cartes_ligue disable trigger bd_garder_proprietaire;
update public.posts p set owner_id = o.owner_id::uuid from storage.objects o
 where o.bucket_id = 'photos' and o.owner_id is not null and p.owner_id is null and p.created_at < timestamptz '2026-11-21'
   and o.name = split_part(substring(p.photo_url from '/photos/(.*)$'), '?', 1)
   and exists (select 1 from auth.users u where u.id::text = o.owner_id);
update public.cartes_ligue c set owner_id = o.owner_id::uuid from storage.objects o
 where o.bucket_id = 'photos' and o.owner_id is not null and c.owner_id is null and c.created_at < timestamptz '2026-11-21'
   and o.name = split_part(substring(c.photo_url from '/photos/(.*)$'), '?', 1)
   and exists (select 1 from auth.users u where u.id::text = o.owner_id);
alter table public.posts enable trigger bd_garder_proprietaire;
alter table public.cartes_ligue enable trigger bd_garder_proprietaire;

do $$ declare r record; begin
  for r in select tablename, policyname from pg_policies where schemaname = 'public'
    and tablename in ('posts','idees','commentaires','cartes_ligue','ligue_scores','missions_validees','reactions_detail','reactions','profils','quiz_scores','defis_historique','satisfaction','collections','admins')
  loop execute format('drop policy %I on public.%I', r.policyname, r.tablename); end loop;
end $$;

create policy posts_lecture on public.posts for select to anon, authenticated using (true);
create policy posts_ajout on public.posts for insert to authenticated with check (owner_id = (select auth.uid()) and (coalesce(photo_url, '') = '' or photo_url like 'https://vnoagcaaeqzwnfylmqvn.supabase.co/storage/v1/object/public/photos/%'));
create policy posts_modification on public.posts for update to authenticated using (owner_id = (select auth.uid()) or (select public.est_admin())) with check (owner_id = (select auth.uid()) or (select public.est_admin()));
create policy posts_suppression on public.posts for delete to authenticated using (owner_id = (select auth.uid()) or (select public.est_admin()));
create policy commentaires_lecture on public.commentaires for select to anon, authenticated using (true);
create policy commentaires_ajout on public.commentaires for insert to authenticated with check (owner_id = (select auth.uid()));
create policy commentaires_suppression on public.commentaires for delete to authenticated using (owner_id = (select auth.uid()) or (select public.est_admin()));
create policy reactions_lecture on public.reactions_detail for select to anon, authenticated using (true);
create policy reactions_ajout on public.reactions_detail for insert to authenticated with check (owner_id = (select auth.uid()));
create policy reactions_suppression on public.reactions_detail for delete to authenticated using (owner_id = (select auth.uid()) or (select public.est_admin()));
create policy reactions_anciennes_lecture on public.reactions for select to anon, authenticated using (true);
create policy idees_lecture on public.idees for select to anon, authenticated using (true);
create policy idees_ajout on public.idees for insert to authenticated with check (owner_id = (select auth.uid()));
create policy idees_modification on public.idees for update to authenticated using ((select public.est_admin())) with check ((select public.est_admin()));
create policy idees_suppression on public.idees for delete to authenticated using (owner_id = (select auth.uid()) or (select public.est_admin()));
create policy profils_lecture on public.profils for select to anon, authenticated using (true);
create policy profils_ajout on public.profils for insert to authenticated with check (owner_id = (select auth.uid()));
create policy profils_modification on public.profils for update to authenticated using (owner_id = (select auth.uid()) or owner_id is null or (select public.est_admin())) with check (owner_id = (select auth.uid()) or (select public.est_admin()));
create policy profils_suppression on public.profils for delete to authenticated using ((select public.est_admin()));
create policy missions_lecture on public.missions_validees for select to anon, authenticated using (true);
create policy missions_ajout on public.missions_validees for insert to authenticated with check (owner_id = (select auth.uid()));
create policy missions_suppression on public.missions_validees for delete to authenticated using (owner_id = (select auth.uid()) or (select public.est_admin()));
create policy ligue_lecture on public.cartes_ligue for select to anon, authenticated using (true);
create policy ligue_ajout on public.cartes_ligue for insert to authenticated with check (owner_id = (select auth.uid()) and (coalesce(photo_url, '') = '' or photo_url like 'https://vnoagcaaeqzwnfylmqvn.supabase.co/storage/v1/object/public/photos/%'));
create policy ligue_modification on public.cartes_ligue for update to authenticated using (owner_id = (select auth.uid()) or (select public.est_admin())) with check (owner_id = (select auth.uid()) or (select public.est_admin()));
create policy ligue_suppression on public.cartes_ligue for delete to authenticated using (owner_id = (select auth.uid()) or (select public.est_admin()));
create policy scores_lecture on public.ligue_scores for select to anon, authenticated using (true);
create policy quiz_lecture on public.quiz_scores for select to anon, authenticated using (true);
create policy quiz_suppression on public.quiz_scores for delete to authenticated using ((select public.est_admin()));
create policy defis_lecture on public.defis_historique for select to anon, authenticated using (true);
create policy defis_suppression on public.defis_historique for delete to authenticated using ((select public.est_admin()));
create policy satisfaction_insertion on public.satisfaction for insert to authenticated with check ((select auth.uid()) is not null);
create policy satisfaction_lecture_admin on public.satisfaction for select to authenticated using ((select public.est_admin()));
create policy satisfaction_suppression_admin on public.satisfaction for delete to authenticated using ((select public.est_admin()));
create policy "Lecture publique des collections" on public.collections for select to anon, authenticated using (true);
create policy "Ajout de ses propres entrées" on public.collections for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Suppression de ses propres entrées" on public.collections for delete to authenticated using ((select auth.uid()) = user_id);
create policy admins_lecture_de_soi on public.admins for select to authenticated using (email = ((select auth.jwt()) ->> 'email'));

revoke insert, update, delete, truncate on public.posts, public.idees, public.commentaires, public.cartes_ligue, public.ligue_scores, public.missions_validees, public.reactions_detail, public.reactions, public.profils, public.quiz_scores, public.defis_historique, public.satisfaction, public.collections, public.admins, public.ia_budget from anon;
revoke truncate on public.posts, public.idees, public.commentaires, public.cartes_ligue, public.ligue_scores, public.missions_validees, public.reactions_detail, public.reactions, public.profils, public.quiz_scores, public.defis_historique, public.satisfaction, public.collections, public.admins, public.ia_budget from authenticated;
revoke insert, update, delete on public.admins from authenticated;
revoke update on public.posts from authenticated;
grant update (espece, espece_sci, lieu, note) on public.posts to authenticated;
revoke update on public.cartes_ligue from authenticated;
grant update (xp) on public.cartes_ligue to authenticated;

drop policy if exists "Envoi de photos par tous" on storage.objects;
drop policy if exists "Suppression de photos par tous" on storage.objects;
drop policy if exists "Envoi de photos (identité requise)" on storage.objects;
drop policy if exists "Suppression de ses photos" on storage.objects;
create policy "Envoi de photos (identité requise)" on storage.objects for insert to authenticated with check (bucket_id = 'photos' and (name like 'post-%.jpg' or name like 'ligue-%.jpg'));
create policy "Suppression de ses photos" on storage.objects for delete to authenticated using (bucket_id = 'photos' and (owner_id = (select auth.uid())::text or (select public.est_admin())));

create index if not exists collections_user_id_idx on public.collections (user_id);
