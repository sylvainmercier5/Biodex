// Match d'identification : Claude (tel que dans BioDex, et en version corrigée)
// sur les 123 photos iNaturalist de l'essai BioCLIP de Goupil.
//
// Usage : node outils/match-identification.mjs [variante] [nbMax]
//   variante : actuel | corrige | les-deux (défaut)
// La clé API est lue dans %USERPROFILE%\.biodex\cle-anthropic.txt (jamais affichée).
// Les résultats vont dans outils/resultats/ (ignoré par Git).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ESSAI = "C:/Goupil/naturaliste/essai";
const SORTIE = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, "$1"), "resultats");
const CLE = fs.readFileSync(path.join(os.homedir(), ".biodex", "cle-anthropic.txt"), "utf8").trim();
const PLAFOND_DOLLARS = 8; // arrêt de sécurité

const variante = process.argv[2] || "les-deux";
const nbMax = Number(process.argv[3] || 999);

// Contexte de terrain : la même info régionale que la liste Limousin de BioCLIP.
const CONTEXTE = "\n\nContexte de terrain (à exploiter, sans le sur-interpréter) :\n- Région approximative : Limousin (France)";

// Prompt système : copie exacte du mode « identification » de netlify/functions/identifier.js
const SYSTEME =
  "Tu es un entomologiste expert en identification visuelle, compétent sur la faune du monde entier. Analyse la ou les photos avec méthode : " +
  "observe le nombre de pattes, la présence et le type d'ailes, les antennes, les pièces buccales, la forme du corps, " +
  "les proportions et la taille estimée, les couleurs et motifs. Déduis d'abord l'ordre, puis affine autant que l'image le permet. " +
  "Utilise le contexte de terrain comme un FILTRE BIOGÉOGRAPHIQUE : la région/zone climatique indiquée oriente vers la faune locale " +
  "(privilégie les espèces réellement présentes dans cette partie du monde ; une espèce européenne est improbable sous les tropiques, et inversement) ; " +
  "la saison (mois) restreint les espèces au stade adulte visible à cette période — attention, les saisons sont inversées dans l'hémisphère sud ; " +
  "le biotope écarte les espèces au habitat incompatible. " +
  "Si aucune région n'est fournie, ne suppose aucune localisation particulière et raisonne uniquement sur les critères visuels. " +
  "SI PLUSIEURS PHOTOS te sont fournies, elles montrent le MÊME individu sous des angles différents (dessus, profil, détail...) : croise-les pour affiner ton identification, " +
  "car un critère invisible sur une vue peut être décisif sur une autre. Ta confiance doit refléter ce gain d'information. " +
  "Écarte activement les hypothèses incohérentes avec ce contexte, MAIS l'image prime toujours : si un critère visuel contredit le contexte, fie-toi à l'image et signale-le. " +
  "Cas particulier IMPORTANT : si tu es visuellement confiant sur une espèce mais que sa présence détonne avec la région/saison indiquée " +
  "(espèce potentiellement invasive, échappée d'élevage, en expansion, ou individu transporté), garde ton identification visuelle ET renseigne le champ \"inhabituel\". " +
  "Propose jusqu'à 3 hypothèses classées de la plus probable à la moins probable. " +
  "Ne force jamais une espèce précise si l'image ne le permet pas : reste au genre, à la famille ou à l'ordre selon ta certitude réelle. " +
  "Réponds UNIQUEMENT par un objet JSON valide, sans texte ni Markdown autour, de la forme exacte : " +
  '{"nom":"nom vernaculaire français de l\'hypothèse principale",' +
  '"nomSci":"binôme ou taxon latin de l\'hypothèse principale",' +
  '"confiance":un nombre entier de 0 à 100 exprimant ton pourcentage de certitude réel dans cette identification (100 = certitude absolue, 50 = hésitation, 20 = très incertain),' +
  '"niveau":"espèce|genre|famille|ordre",' +
  '"note":"justification courte : critères visuels décisifs, ou pourquoi l\'ID reste incertaine",' +
  '"role":"UNE phrase courte et concrète (max ~15 mots) sur le rôle écologique / l\'utilité de cet arthropode : pollinisation, recyclage de matière, régulation d\'autres espèces, maillon alimentaire, aération du sol, etc. Formulation grand public, sans jargon. Vide si vraiment inconnu.",' +
  '"ordre":"le grand groupe d\'arthropodes, en UN seul mot parmi exactement : lepidopteres, coleopteres, hymenopteres, dipteres, hemipteres, orthopteres, odonates, arachnides, myriapodes. Si aucun ne convient ou incertain : autres.",' +
  '"inhabituel":"vide si de présence normale pour la zone ; SINON une phrase expliquant pourquoi cette observation est notable (ex : espèce invasive en expansion, hors de son aire habituelle, échappée...)",' +
  '"contact":"UN mot parmi exactement : inoffensif (se manipule sans risque), defensif (peut piquer, mordre ou pincer si on le manipule), douloureux (piqûre ou morsure douloureuse, ne pas manipuler), urticant (poils ou sécrétions irritants, ne pas toucher), inconnu. Sois prudent : dans le doute entre deux niveaux, choisis le plus élevé.",' +
  '"contact_note":"une phrase courte et concrète de conseil de manipulation (ex : Ne le prends pas dans la main, sa piqûre est douloureuse), vide si inoffensif",' +
  '"alternatives":[{"nom":"","nomSci":"","pourquoi":"ce qui distinguerait cette hypothèse"}]}. ' +
  "Le tableau alternatives contient 0 à 2 hypothèses secondaires (vide si tu es très sûr).";

const VARIANTES = {
  // Exactement ce que fait BioDex aujourd'hui (sans réflexion, 780 jetons de sortie)
  actuel: { model: "claude-opus-4-8", max_tokens: 780, extra: {}, tarif: { e: 5, s: 25 } },
  // Version corrigée : modèle récent, réflexion adaptative (toujours active), effort moyen
  corrige: { model: "claude-opus-5-5", max_tokens: 16000, extra: { output_config: { effort: "medium" } }, tarif: { e: 4, s: 20 } },
  // Duo : même chose que « corrige », mais Claude reçoit les 5 candidats de BioCLIP (liste Limousin)
  duo: { model: "claude-opus-5-5", max_tokens: 16000, extra: { output_config: { effort: "medium" } }, tarif: { e: 4, s: 20 }, candidats: true },
};

// Candidats BioCLIP (liste Limousin, recadrage « oc ») pour chaque photo
const BIO = JSON.parse(fs.readFileSync(`${ESSAI}/resultats_bruts.json`, "utf8")).photos
  .filter((x) => x.liste === "limousin" && x.prep === "oc");
function blocCandidats(fichier) {
  const b = BIO.find((x) => x.fichier === fichier);
  if (!b) return "";
  const lignes = b.espece.top.slice(0, 5).map((s, i) => `${i + 1}. ${s} (probabilité ${Math.round(b.espece.p[i] * 100)} %)`);
  return "\n\nAvis d'un modèle de reconnaissance spécialisé (BioCLIP), qui choisit uniquement parmi les espèces connues dans la région :\n" +
    lignes.join("\n") +
    "\nC'est un indice fort, souvent juste quand sa probabilité dépasse 80 %. Mais vérifie-le sur l'image : il confond parfois des espèces sœurs du même genre, " +
    "il se laisse moins piéger que toi par les mimétismes, et il ignore toute espèce absente de sa liste. " +
    "Si l'image contredit clairement ses propositions, fie-toi à l'image et dis-le dans la note.";
}

let depense = 0;

async function appeler(v, image, fichier) {
  const conf = VARIANTES[v];
  const indice = conf.candidats ? blocCandidats(fichier) : "";
  const corps = {
    model: conf.model,
    max_tokens: conf.max_tokens,
    system: SYSTEME,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
      { type: "text", text: "Identifie cet arthropode." + CONTEXTE + indice },
    ] }],
    ...conf.extra,
  };
  for (let essai = 1; essai <= 4; essai++) {
    const t0 = Date.now();
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": CLE, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(corps),
    });
    if (r.status === 429 || r.status >= 500) { await new Promise((ok) => setTimeout(ok, 5000 * essai)); continue; }
    const d = await r.json();
    if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(d).slice(0, 300)}`);
    const u = d.usage || {};
    const cout = ((u.input_tokens || 0) * conf.tarif.e + (u.output_tokens || 0) * conf.tarif.s) / 1e6;
    depense += cout;
    const texte = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    let res = null;
    try { res = JSON.parse(texte.replace(/```json/gi, "").replace(/```/g, "").trim()); } catch {}
    return { res, brut: res ? undefined : texte.slice(0, 300), stop: d.stop_reason, ms: Date.now() - t0, cout, entree: u.input_tokens, sortie: u.output_tokens };
  }
  throw new Error("API indisponible après 4 essais");
}

function binome(s) { return String(s || "").trim().toLowerCase().split(/\s+/).slice(0, 2).join(" "); }
function genre(s) { return String(s || "").trim().toLowerCase().split(/\s+/)[0]; }

const meta = JSON.parse(fs.readFileSync(`${ESSAI}/metadonnees.json`, "utf8")).slice(0, nbMax);
fs.mkdirSync(SORTIE, { recursive: true });
const fichier = path.join(SORTIE, "match.json");
const resultats = fs.existsSync(fichier) ? JSON.parse(fs.readFileSync(fichier, "utf8")) : {};
const aFaire = variante === "les-deux" ? ["actuel", "corrige"] : [variante];
if (!aFaire.every((v) => VARIANTES[v])) throw new Error("Variante inconnue : " + variante);

for (const m of meta) {
  const image = fs.readFileSync(`${ESSAI}/photos/${m.fichier}`).toString("base64");
  for (const v of aFaire) {
    const cle = `${v}|${m.fichier}`;
    if (resultats[cle] && !resultats[cle].erreur) continue; // reprise possible
    if (depense > PLAFOND_DOLLARS) { console.log(`Plafond de ${PLAFOND_DOLLARS} $ atteint, arrêt.`); break; }
    try {
      const r = await appeler(v, image, m.fichier);
      const sci = r.res && r.res.nomSci;
      resultats[cle] = { ...r, vrai: m.espece, nomSci: sci, espece_ok: binome(sci) === binome(m.espece), genre_ok: genre(sci) === genre(m.espece) };
    } catch (e) {
      resultats[cle] = { erreur: String(e.message || e).slice(0, 300), vrai: m.espece };
    }
    const x = resultats[cle];
    console.log(`${v.padEnd(7)} ${m.fichier.padEnd(45)} ${x.erreur ? "ERREUR " + x.erreur : (x.espece_ok ? "✓" : x.genre_ok ? "~" : "✗") + " " + (x.nomSci || "(illisible)")}  ${depense.toFixed(2)} $`);
    fs.writeFileSync(fichier, JSON.stringify(resultats, null, 1));
  }
}

// Bilan
for (const v of aFaire) {
  const l = Object.entries(resultats).filter(([k]) => k.startsWith(v + "|")).map(([, x]) => x).filter((x) => !x.erreur);
  if (!l.length) continue;
  const pc = (f) => Math.round(100 * l.filter(f).length / l.length);
  const moy = (f) => Math.round(l.reduce((a, x) => a + (f(x) || 0), 0) / l.length);
  console.log(`\n${v} : ${l.length} photos | espèce ${pc((x) => x.espece_ok)} % | genre ${pc((x) => x.genre_ok)} % | ${moy((x) => x.ms)} ms/photo | ${(l.reduce((a, x) => a + x.cout, 0)).toFixed(2)} $`);
}
console.log(`\nDépense de cette exécution : ${depense.toFixed(2)} $`);
