# Mise en ligne de la sécurité (v1.80)

Cette version fait en sorte que seul l'auteur d'une publication, d'une idée ou d'une carte (ou l'admin) puisse la modifier ou la supprimer. Avant, n'importe quel visiteur pouvait tout effacer.

**L'ordre compte.** Si on inverse les étapes, le mur ne se charge plus (étape 3 avant l'étape 2), ou les anciennes versions de l'appli ne peuvent plus écrire trop tôt (étape 5 trop tôt).

## 1. Activer la connexion anonyme dans Supabase

Tableau de bord Supabase → projet **BioDex** → **Authentication** → **Sign In / Providers** → activer **Allow anonymous sign-ins** → **Save**.

Au passage, dans **Authentication** → **Attack Protection** (ou **Password security**), activer **Leaked password protection** (alerte de l'audit).

## 2. Appliquer l'étape SQL 1 : `migrations/20261121_01_proprietaires.sql`

Cette étape ne retire aucun droit : l'appli actuelle continue de marcher à l'identique. Elle ajoute la colonne `owner_id`, le déclencheur qui la protège, et les trois fonctions serveur des scores.

Dans Supabase : **SQL Editor** → coller le fichier → **Run**. Claude peut aussi le faire à ta demande.

## 3. Mettre en ligne la v1.80 de l'appli

Fusionner la branche `securite/proprietaires` dans `main` et publier sur Netlify, comme d'habitude.

## 4. Laisser la bande passer à la v1.80

Chacun voit la bannière « Mettre à jour » à sa prochaine ouverture. Quelques jours suffisent en général.

## 5. Appliquer l'étape SQL 2 : `migrations/20261121_02_verrouillage.sql`

C'est le verrou. À partir de là :

- seul l'auteur (ou l'admin) peut modifier ou supprimer ce qu'il a publié ;
- une version de l'appli antérieure à la v1.80 ne peut plus écrire (elle peut toujours lire) ;
- les scores de la ligue, de l'arène et du quiz ne passent plus que par le serveur et ne peuvent plus être effacés.

## Ce qu'il faut savoir

- **Contenus d'avant la v1.80.** Ils n'ont pas de propriétaire connu : seul l'admin peut les modifier ou les supprimer. Ça concerne les publications, idées, cartes de ligue, validations de missions et réactions.
  - Un auteur ne voit donc plus les boutons Modifier et Supprimer sur ses anciennes publications.
  - Retirer une ancienne carte de ligue ou décocher une ancienne mission affiche un message clair au lieu d'échouer en silence.
  - Retirer une ancienne réaction ne fonctionne plus : elle revient au rafraîchissement.
- **Profils d'avant la v1.80.** La première personne qui modifie un profil sans propriétaire le récupère. Sans ça, personne ne pourrait plus changer son emblème. Dans la théorie, quelqu'un pourrait donc s'approprier le profil d'un autre avant lui. L'admin peut corriger.
- **Le prénom reste libre.** Rien n'empêche encore de publier sous le prénom de quelqu'un d'autre. Ce qui est protégé, c'est la modification et la suppression.
- **Changer de téléphone, ou vider les données du navigateur, crée une nouvelle identité.** Les publications faites avec l'ancienne ne sont alors plus modifiables par leur auteur, seulement par l'admin. Même chose après « Se déconnecter » d'un compte e-mail.
- **Les scores restent trichables** : c'est le téléphone qui annonce qui a gagné. Mais on ne peut plus que les faire monter de +1, jamais les effacer ni réécrire ceux des autres.

## Vérification

Les règles des deux étapes ont été testées le 21/11/2026 sur la vraie base, dans une transaction annulée à la fin : rien n'a été enregistré. Les 22 scénarios sont passés :

- un visiteur ne peut pas supprimer la publication d'un autre ;
- on ne peut pas se donner de victoires ;
- un score ne redescend pas ;
- l'admin garde la main ;
- etc.
