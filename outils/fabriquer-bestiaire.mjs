// Fabrique bestiaire-limousin.json : pour chaque grand groupe de BioDex, le nombre d'espèces
// d'insectes connues dans le Limousin et les plus communes (à afficher en silhouettes à découvrir).
// Sources (dans C:\Goupil\naturaliste, préparées pour BioCLIP) :
//   listes/limousin.json           espèces + classe/ordre/famille/genre (arbre du vivant BioCLIP 2)
//   essai/limousin_insectes_inat.json  nombre d'observations iNaturalist par espèce (= « commune »)
//   noms-fr.json                   noms français (iNaturalist + TAXREF)
// Usage : node outils/fabriquer-bestiaire.mjs
import fs from "node:fs";

const N = "C:/Goupil/naturaliste/";
const lire = (f) => JSON.parse(fs.readFileSync(N + f, "utf8"));
const taxons = lire("listes/limousin.json").taxons;            // [classe, ordre, famille, genre, espèce]
const comptes = Object.fromEntries(lire("essai/limousin_insectes_inat.json").map((x) => [x.nom, x.n || 0]));
const nomsFr = lire("noms-fr.json");

const GROUPES = { Lepidoptera: "lepidopteres", Coleoptera: "coleopteres", Hymenoptera: "hymenopteres", Diptera: "dipteres",
  Hemiptera: "hemipteres", Orthoptera: "orthopteres", Odonata: "odonates" };
const PAR_GROUPE = 8; // silhouettes proposées par groupe : les plus communes, donc trouvables

const groupes = {};
for (const [, ordre, famille, , espece] of taxons) {
  const id = GROUPES[ordre] || "autres";
  (groupes[id] = groupes[id] || []).push({ s: espece, f: nomsFr[espece] || "", fam: famille, n: comptes[espece] || 0 });
}
const sortie = { source: "iNaturalist (Limousin) + BioCLIP 2", date: new Date().toISOString().slice(0, 10), groupes: {} };
for (const [id, liste] of Object.entries(groupes)) {
  liste.sort((a, b) => b.n - a.n);
  sortie.groupes[id] = {
    total: liste.length,
    communes: liste.filter((x) => x.f).slice(0, PAR_GROUPE).map(({ s, f }) => ({ s, f })),
  };
}
// Le résultat va dans index.html (constante BESTIAIRE_LIMOUSIN) : remplacer la ligne qui commence
// par « const BESTIAIRE_LIMOUSIN = » par celle affichée ci-dessous.
for (const [id, g] of Object.entries(sortie.groupes)) console.error(id.padEnd(13), String(g.total).padStart(5), "espèces ·", g.communes.slice(0, 3).map((x) => x.f).join(", "));
console.log("const BESTIAIRE_LIMOUSIN = " + JSON.stringify(sortie) + ";");
