// Compare les fiches naturalistes et les cartes de jeu produites par la vraie fonction,
// avec les modèles configurés (variables BIODEX_MODELE_FICHE / BIODEX_MODELE_CARTE si fournies).
// Usage : node outils/comparer-fiches-cartes.mjs <étiquette>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
process.env.ANTHROPIC_API_KEY = fs.readFileSync(path.join(os.homedir(), ".biodex", "cle-anthropic.txt"), "utf8").trim();
const { handler } = require("../netlify/functions/identifier.js");
const etiquette = process.argv[2] || "essai";

const ESPECES = [
  ["Lucane cerf-volant", "Lucanus cervus"],
  ["Frelon européen", "Vespa crabro"],
  ["Processionnaire du pin", "Thaumetopoea pityocampa"],
  ["Volucelle zonée", "Volucella zonaria"],
];
const sortie = {};
let i = 0;
for (const [nom, nomSci] of ESPECES) {
  for (const mode of ["fiche", "carte"]) {
    const t0 = Date.now();
    const r = await handler({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": "10.1.0." + i++ }, body: JSON.stringify({ mode, nom, nomSci }) });
    const d = JSON.parse(r.body);
    sortie[`${mode}|${nomSci}`] = { ms: Date.now() - t0, statut: r.statusCode, resultat: d.resultat, erreur: d.erreur };
    const x = d.resultat || {};
    const resume = mode === "fiche"
      ? `contact=${x.contact} | fiabilite=${x.fiabilite} | conservation=${String(x.conservation || "").slice(0, 70)}`
      : `A${x.attaque}/D${x.defense}/V${x.vitesse} R${x.rarete} ${x.element} | ${x.capacite && x.capacite.nom} (${x.capacite && x.capacite.famille})`;
    console.log(`${etiquette.padEnd(8)} ${mode.padEnd(5)} ${nomSci.padEnd(26)} ${r.statusCode} ${String(Date.now() - t0).padStart(6)} ms  ${resume}`);
  }
}
fs.mkdirSync(new URL("./resultats/", import.meta.url), { recursive: true });
fs.writeFileSync(new URL(`./resultats/fiches-cartes-${etiquette}.json`, import.meta.url), JSON.stringify(sortie, null, 1));
