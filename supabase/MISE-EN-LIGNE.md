# Sécurité de BioDex (v1.80) : état au 23/11/2026

**Tout est en place.** Seul l'auteur d'une publication, d'une idée, d'une carte… (ou l'admin) peut la modifier ou la supprimer. Avant, n'importe quel visiteur pouvait tout effacer.

| Étape | Fichier | État |
|---|---|---|
| Connexion anonyme activée dans Supabase | (tableau de bord) | ✅ 21/11 |
| 1. Propriétaires (`owner_id`, fonctions de score) | `migrations/20261121_01_proprietaires.sql` | ✅ appliquée le 21/11 |
| Appli v1.80 en ligne | `index.html`, `sw.js` | ✅ publiée le 21/11 |
| 2. Verrouillage | `migrations/20261123_verrouillage.sql` | ✅ appliquée le 23/11 |

L'étape 2 d'origine (`20261121_02_verrouillage.sql`) a été **remplacée** par une version améliorée, préparée depuis la session Goupil. Elle a été retirée du dépôt : **ne pas la repasser**, elle annulerait les améliorations.

Retour arrière d'urgence (rouvre les failles, en dernier recours) : `retour-arriere-20261123.sql`.

## Ce qu'il faut savoir

- **Versions d'avant la v1.80 restées en cache :** elles peuvent lire, mais plus écrire (« Publication impossible »). Il suffit de toucher « Mettre à jour ».
- **Anciennes publications :**
  - 284 posts sur 390 et 8 cartes ont été rendus à leurs auteurs. Ce sont ceux dont la photo avait été envoyée depuis un compte e-mail.
  - Les autres ne sont modifiables que par l'admin.
  - Retirer une ancienne carte, ou décocher une ancienne mission, affiche un message clair.
- **Profils anciens :** la première personne qui modifie un profil sans propriétaire le récupère. L'admin peut corriger si quelqu'un prend celui d'un autre.
- **Le prénom reste libre :** on peut publier sous le prénom de quelqu'un d'autre. Ce qui est protégé, c'est la modification et la suppression.
- **Changer de téléphone ou vider les données du navigateur** crée une nouvelle identité. Les publications faites avec l'ancienne ne sont alors plus modifiables que par l'admin.
- **Scores :** toujours trichables, puisque c'est le téléphone qui annonce le gagnant. Mais on ne peut que les faire monter de +1, jamais les effacer.
- **Règles écrites en dur :** l'adresse du bucket Supabase, et les noms de fichiers `post-…jpg` / `ligue-…jpg`. À retoucher si l'un des deux change.
- **« Leaked password protection » :** cette alerte ne concerne pas BioDex, qui n'utilise aucun mot de passe (lien magique et identité anonyme).

## Vérifications faites

- **21/11 :** 22 scénarios de l'étape 2 d'origine, testés dans une transaction annulée.
- **23/11 :** 14 gestes de la v1.80 simulés contre la base verrouillée, dans une transaction annulée. Tous OK :
  - publier, modifier et supprimer sa publication ;
  - réagir, commenter, proposer une idée, donner un avis ;
  - modifier son profil, valider une mission ;
  - engager une carte, défier une ancienne carte sans s'en emparer ;
  - enregistrer les scores du quiz et de l'arène ;
  - refus de supprimer la publication d'un autre.
- **Pas encore vérifié en vrai :** l'envoi d'une photo dans le stockage sous la nouvelle règle de noms de fichiers. À tester avec une vraie publication depuis l'appli.
