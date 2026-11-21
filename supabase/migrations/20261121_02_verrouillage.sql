-- ============================================================================
-- BioDex — Sécurité, étape 2/2 : VERROUILLAGE
-- ============================================================================
-- À passer APRÈS : l'étape 1, l'activation des connexions anonymes dans Supabase,
-- et la mise en ligne de la nouvelle appli (laisser à la bande le temps de faire
-- la mise à jour : les anciennes versions ne pourront plus écrire).
--
-- Règle générale :
--   • Lire : tout le monde (comme avant).
--   • Écrire : il faut une identité (la connexion anonyme automatique suffit).
--   • Modifier / supprimer : seulement ce qui t'appartient — ou l'admin.
--   • Lignes anciennes (sans propriétaire) : seul l'admin peut les modifier ou
--     les supprimer. Exception : les profils, que la première personne qui les
--     modifie récupère (sinon personne ne pourrait plus changer son emblème).
--   • Scores et compteurs : uniquement via les fonctions serveur de l'étape 1.
-- ============================================================================

-- ── Ménage : on retire toutes les anciennes règles des tables concernées ───
do $$
declare r record;
begin
  for r in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('posts','idees','commentaires','cartes_ligue','ligue_scores',
                        'missions_validees','reactions_detail','reactions','profils',
                        'quiz_scores','defis_historique')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- ── Publications du mur ─────────────────────────────────────────────────────
create policy posts_lecture      on public.posts for select to anon, authenticated using (true);
create policy posts_ajout        on public.posts for insert to authenticated with check (owner_id = auth.uid());
create policy posts_modification on public.posts for update to authenticated
  using (owner_id = auth.uid() or public.est_admin())
  with check (owner_id = auth.uid() or public.est_admin());
create policy posts_suppression  on public.posts for delete to authenticated
  using (owner_id = auth.uid() or public.est_admin());

-- ── Commentaires ────────────────────────────────────────────────────────────
create policy commentaires_lecture     on public.commentaires for select to anon, authenticated using (true);
create policy commentaires_ajout       on public.commentaires for insert to authenticated with check (owner_id = auth.uid());
create policy commentaires_suppression on public.commentaires for delete to authenticated
  using (owner_id = auth.uid() or public.est_admin());

-- ── Réactions ───────────────────────────────────────────────────────────────
create policy reactions_lecture     on public.reactions_detail for select to anon, authenticated using (true);
create policy reactions_ajout       on public.reactions_detail for insert to authenticated with check (owner_id = auth.uid());
create policy reactions_suppression on public.reactions_detail for delete to authenticated
  using (owner_id = auth.uid() or public.est_admin());

-- Ancienne table de compteurs, plus utilisée : lecture seule.
create policy reactions_anciennes_lecture on public.reactions for select to anon, authenticated using (true);

-- ── Boîte à idées ───────────────────────────────────────────────────────────
create policy idees_lecture     on public.idees for select to anon, authenticated using (true);
create policy idees_ajout       on public.idees for insert to authenticated with check (owner_id = auth.uid());
-- « Réalisée » : réservé à l'admin (avant, aucune règle ne l'autorisait : le bouton échouait).
create policy idees_modification on public.idees for update to authenticated
  using (public.est_admin()) with check (public.est_admin());
create policy idees_suppression on public.idees for delete to authenticated
  using (owner_id = auth.uid() or public.est_admin());

-- ── Profils ─────────────────────────────────────────────────────────────────
create policy profils_lecture on public.profils for select to anon, authenticated using (true);
create policy profils_ajout   on public.profils for insert to authenticated with check (owner_id = auth.uid());
-- Un profil ancien (sans propriétaire) est attribué à la première personne qui
-- le modifie (le déclencheur de l'étape 1 remplit owner_id).
create policy profils_modification on public.profils for update to authenticated
  using (owner_id = auth.uid() or owner_id is null or public.est_admin())
  with check (owner_id = auth.uid() or public.est_admin());
create policy profils_suppression on public.profils for delete to authenticated
  using (public.est_admin());

-- ── Missions validées ───────────────────────────────────────────────────────
create policy missions_lecture     on public.missions_validees for select to anon, authenticated using (true);
create policy missions_ajout       on public.missions_validees for insert to authenticated with check (owner_id = auth.uid());
create policy missions_suppression on public.missions_validees for delete to authenticated
  using (owner_id = auth.uid() or public.est_admin());

-- ── Cartes de la ligue ──────────────────────────────────────────────────────
create policy ligue_lecture      on public.cartes_ligue for select to anon, authenticated using (true);
create policy ligue_ajout        on public.cartes_ligue for insert to authenticated with check (owner_id = auth.uid());
-- Le propriétaire peut monter l'XP de sa carte ; les victoires/défaites passent
-- par enregistrer_defi().
create policy ligue_modification on public.cartes_ligue for update to authenticated
  using (owner_id = auth.uid() or public.est_admin())
  with check (owner_id = auth.uid() or public.est_admin());
create policy ligue_suppression  on public.cartes_ligue for delete to authenticated
  using (owner_id = auth.uid() or public.est_admin());

-- Le propriétaire ne doit pas pouvoir se donner des victoires à la main :
-- on n'autorise en écriture directe que la colonne xp.
revoke update on public.cartes_ligue from anon, authenticated;
grant  update (xp) on public.cartes_ligue to authenticated;

-- ── Scores et historique : lecture seule, écriture via les fonctions ────────
create policy scores_lecture      on public.ligue_scores     for select to anon, authenticated using (true);
create policy quiz_lecture        on public.quiz_scores      for select to anon, authenticated using (true);
create policy quiz_suppression    on public.quiz_scores      for delete to authenticated using (public.est_admin());
create policy defis_lecture       on public.defis_historique for select to anon, authenticated using (true);
create policy defis_suppression   on public.defis_historique for delete to authenticated using (public.est_admin());

-- ── Photos (stockage) ───────────────────────────────────────────────────────
-- Supabase note lui-même qui a envoyé chaque fichier (storage.objects.owner_id).
drop policy if exists "Envoi de photos par tous"       on storage.objects;
drop policy if exists "Suppression de photos par tous" on storage.objects;

create policy "Envoi de photos (identité requise)" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos');

create policy "Suppression de ses photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and (owner_id = auth.uid()::text or public.est_admin()));
