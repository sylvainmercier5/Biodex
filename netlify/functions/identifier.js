// netlify/functions/identifier.js
// Fonction serverless BioDex : identification d'insecte + fiche naturaliste, via l'API Claude (Sonnet).
// La clé API vit UNIQUEMENT ici (variable d'environnement Netlify), jamais dans le navigateur.

const MODELE = "claude-sonnet-4-6";

// Garde-fou léger (anti-accident, pas anti-attaque déterminée) : limite par IP.
// Stockage en mémoire de l'instance ; se réinitialise quand la fonction "dort". Suffisant pour un cercle privé.
const FENETRE_MS = 60 * 60 * 1000; // 1 heure
const MAX_PAR_FENETRE = 40;        // 40 appels/heure/IP — large pour un usage normal, bloque les boucles accidentelles
const _appels = new Map();         // ip -> [timestamps]

function limiteAtteinte(ip) {
  const maintenant = Date.now();
  const recents = (_appels.get(ip) || []).filter((t) => maintenant - t < FENETRE_MS);
  if (recents.length >= MAX_PAR_FENETRE) { _appels.set(ip, recents); return true; }
  recents.push(maintenant);
  _appels.set(ip, recents);
  return false;
}

exports.handler = async (event) => {
  const enTetes = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: enTetes, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: enTetes, body: JSON.stringify({ erreur: "Méthode non autorisée" }) };
  }

  // Limite par IP (garde-fou léger)
  const ip = (event.headers && (event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || event.headers["x-forwarded-for"])) || "inconnue";
  if (limiteAtteinte(String(ip).split(",")[0].trim())) {
    return { statusCode: 429, headers: enTetes, body: JSON.stringify({ erreur: "Trop de demandes d'affilée. Patiente un moment avant de réessayer." }) };
  }

  const cle = process.env.ANTHROPIC_API_KEY;
  if (!cle) {
    return { statusCode: 500, headers: enTetes, body: JSON.stringify({ erreur: "Clé API non configurée sur le serveur." }) };
  }

  let corps;
  try { corps = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: enTetes, body: JSON.stringify({ erreur: "Requête illisible." }) }; }

  const mode = corps.mode || "identification";

  // Contexte fourni par l'observateur (aide l'identification)
  const ctx = [];
  if (corps.contexte) {
    const c = corps.contexte;
    if (c.biotope) ctx.push("Biotope observé : " + String(c.biotope).slice(0, 60));
    if (c.mois) ctx.push("Mois d'observation : " + String(c.mois).slice(0, 20));
    if (c.region) ctx.push("Région approximative : " + String(c.region).slice(0, 60));
    if (c.indice) ctx.push("Nom supposé par l'observateur : " + String(c.indice).slice(0, 120));
  }
  const blocCtx = ctx.length ? "\n\nContexte de terrain (à exploiter, sans le sur-interpréter) :\n- " + ctx.join("\n- ") : "";

  // ---- Construction du message selon le mode ----
  let messages, maxTokens, systeme;

  if (mode === "affinage") {
    // Dialogue de détermination : on renvoie l'image + l'historique des questions/réponses.
    if (!corps.image || !corps.media_type) {
      return { statusCode: 400, headers: enTetes, body: JSON.stringify({ erreur: "Image manquante." }) };
    }
    const historique = Array.isArray(corps.historique) ? corps.historique.slice(0, 8) : [];
    const nbPoses = historique.length;
    systeme =
      "Tu es un entomologiste qui mène une clé de détermination interactive avec l'observateur. " +
      "Tu disposes de la photo et des réponses déjà données. Ton but : converger vers l'identification la plus précise possible. " +
      "À chaque tour, DEUX possibilités :\n" +
      "1) S'il reste une ambiguïté que l'observateur peut lever, pose UNE seule question ciblée sur un critère observable à l'œil " +
      "(antennes, pattes, taille réelle, motif, comportement, plante-hôte...). Propose 2 à 4 réponses courtes et exclusives. " +
      "2) Si tu es désormais suffisamment sûr, OU si tu as déjà posé " + (nbPoses >= 3 ? "assez de" : "plusieurs") + " questions, conclus par une identification finale. " +
      (nbPoses >= 3 ? "Tu as déjà posé au moins 3 questions : tu DOIS conclure maintenant. " : "") +
      "Réponds UNIQUEMENT par un objet JSON valide, sans texte ni Markdown autour :\n" +
      'soit {"type":"question","question":"...","options":["...","..."],"pourquoi":"ce que ce critère permet de trancher"}\n' +
      'soit {"type":"final","nom":"nom vernaculaire FR","nomSci":"binôme latin","confiance":"élevée|moyenne|faible","niveau":"espèce|genre|famille|ordre","note":"synthèse de la détermination"}. ' +
      "L'observateur peut répondre \"Je ne sais pas\" : dans ce cas ne réinsiste pas sur le même critère.";
    const contenu = [
      { type: "image", source: { type: "base64", media_type: corps.media_type, data: corps.image } },
      { type: "text", text: "Détermination en cours." + blocCtx + (historique.length
        ? "\n\nÉchanges déjà réalisés :\n" + historique.map((h, i) => `Q${i + 1}: ${h.question}\nR${i + 1}: ${h.reponse}`).join("\n")
        : "\n\nPremier tour : pose ta première question de détermination.") },
    ];
    messages = [{ role: "user", content: contenu }];
    maxTokens = 600;
  } else if (mode === "carte") {
    // Génère des stats de jeu équilibrées + une capacité spéciale, ancrées dans la biologie réelle.
    const nom = String(corps.nom || "").slice(0, 120);
    const nomSci = String(corps.nomSci || "").slice(0, 120);
    systeme =
      "Tu es le game designer d'un jeu de cartes à collectionner sur les insectes. " +
      "À partir d'une espèce réelle, tu génères une carte de combat équilibrée dont les stats reflètent la BIOLOGIE réelle de l'animal " +
      "(un lucane a une forte attaque via ses mandibules ; un scarabée une bonne défense via sa cuirasse ; une libellule une grande vitesse ; " +
      "une espèce rare/protégée a une rareté élevée). " +
      "Barème : chaque stat de 1 à 100, équilibrées pour que la SOMME attaque+defense+vitesse soit proche de 150 (ni trop faible, ni surpuissant). " +
      "La rareté (1 à 100) reflète la rareté réelle et le statut de conservation. " +
      "La capacité spéciale est un pouvoir de jeu court inspiré d'un trait réel de l'espèce (vol stationnaire, camouflage, stridulation, dard, bioluminescence, mimétisme...). " +
      "Réponds UNIQUEMENT par un objet JSON valide, sans texte ni Markdown : " +
      '{"attaque":N,"defense":N,"vitesse":N,"rarete":N,' +
      '"element":"un type thématique parmi : Volant, Rampant, Aquatique, Fouisseur, Nocturne, Prédateur, Butineur",' +
      '"capacite":{"nom":"nom court de la capacité","effet":"effet de jeu en une phrase"},' +
      '"citation":"une phrase d\'ambiance évocatrice sur l\'espèce (max 15 mots)"}';
    messages = [{ role: "user", content: [{ type: "text", text: "Crée la carte de : " + nom + (nomSci ? " (" + nomSci + ")" : "") + "." }] }];
    maxTokens = 400;
  } else if (mode === "fiche") {
    // Génération d'une fiche naturaliste à partir d'un nom déjà identifié
    const nom = String(corps.nom || "").slice(0, 120);
    const nomSci = String(corps.nomSci || "").slice(0, 120);
    systeme =
      "Tu es un entomologiste francophone rigoureux. On te donne une espèce (ou un taxon) déjà identifiée. " +
      "Rédige une fiche naturaliste synthétique et fiable, en français. " +
      "IMPORTANT sur le statut de conservation : les listes rouges évoluent et tu ne peux pas les vérifier en temps réel. " +
      "N'affirme JAMAIS un statut avec certitude : donne une indication prudente et signale qu'elle doit être vérifiée. " +
      "Si tu n'es pas sûr d'un champ, mets une valeur honnête comme \"variable\", \"mal connu\" ou \"à vérifier\" plutôt que d'inventer. " +
      "Réponds UNIQUEMENT par un objet JSON valide, sans texte ni Markdown autour, de la forme exacte : " +
      '{"description":"2-3 phrases : allure générale, taille, traits distinctifs",' +
      '"alimentation":"régime de l\'adulte et de la larve si pertinent",' +
      '"periode":"période d\'apparition / mois de vol des adultes",' +
      '"habitat":"habitats et biotopes typiques",' +
      '"repartition":"répartition géographique générale (France/Europe si pertinent)",' +
      '"conservation":"statut indicatif et prudent, ex : \'apparemment commun, à vérifier\' ou \'espèce protégée en France, à confirmer\'",' +
      '"faits":"un ou deux faits marquants ou remarquables",' +
      '"fiabilite":"élevée|moyenne|faible — ta confiance globale dans cette fiche selon que le taxon est commun/bien connu ou non"}';
    messages = [{ role: "user", content: [{ type: "text", text: "Espèce à documenter : " + nom + (nomSci ? " (" + nomSci + ")" : "") + "." }] }];
    maxTokens = 900;
  } else {
    // Identification poussée à partir de la photo
    if (!corps.image || !corps.media_type) {
      return { statusCode: 400, headers: enTetes, body: JSON.stringify({ erreur: "Image manquante." }) };
    }
    systeme =
      "Tu es un entomologiste expert en identification visuelle. Analyse la photo avec méthode : " +
      "observe le nombre de pattes, la présence et le type d'ailes, les antennes, les pièces buccales, la forme du corps, " +
      "les proportions et la taille estimée, les couleurs et motifs. Déduis d'abord l'ordre, puis affine autant que l'image le permet. " +
      "Propose jusqu'à 3 hypothèses classées de la plus probable à la moins probable. " +
      "Ne force jamais une espèce précise si l'image ne le permet pas : reste au genre, à la famille ou à l'ordre selon ta certitude réelle. " +
      "Exploite le contexte de terrain s'il est fourni, mais l'image prime. " +
      "Réponds UNIQUEMENT par un objet JSON valide, sans texte ni Markdown autour, de la forme exacte : " +
      '{"nom":"nom vernaculaire français de l\'hypothèse principale",' +
      '"nomSci":"binôme ou taxon latin de l\'hypothèse principale",' +
      '"confiance":"élevée|moyenne|faible",' +
      '"niveau":"espèce|genre|famille|ordre",' +
      '"note":"justification courte : critères visuels décisifs, ou pourquoi l\'ID reste incertaine",' +
      '"alternatives":[{"nom":"","nomSci":"","pourquoi":"ce qui distinguerait cette hypothèse"}]}. ' +
      "Le tableau alternatives contient 0 à 2 hypothèses secondaires (vide si tu es très sûr).";
    messages = [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: corps.media_type, data: corps.image } },
        { type: "text", text: "Identifie cet arthropode." + blocCtx },
      ],
    }];
    maxTokens = 700;
  }

  try {
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), 25000); // 25 s max
    let reponse;
    try {
      reponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": cle, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODELE, max_tokens: maxTokens, system: systeme, messages }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(minuteur);
    }

    if (!reponse.ok) {
      const txt = await reponse.text();
      return { statusCode: 502, headers: enTetes, body: JSON.stringify({ erreur: "L'API a renvoyé une erreur.", detail: txt.slice(0, 300) }) };
    }

    const data = await reponse.json();
    const texte = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();

    let resultat = null;
    try {
      const propre = texte.replace(/```json/gi, "").replace(/```/g, "").trim();
      resultat = JSON.parse(propre);
    } catch {
      if (mode === "fiche") resultat = { description: texte.slice(0, 500), fiabilite: "faible" };
      else if (mode === "carte") resultat = { attaque: 50, defense: 50, vitesse: 50, rarete: 30, element: "Rampant", capacite: { nom: "Instinct", effet: "Aucun effet particulier." }, citation: "" };
      else resultat = { nom: "", nomSci: "", confiance: "faible", niveau: "", note: texte.slice(0, 300), alternatives: [] };
    }

    return { statusCode: 200, headers: enTetes, body: JSON.stringify({ ok: true, mode, resultat }) };
  } catch (e) {
    if (e && e.name === "AbortError") {
      return { statusCode: 504, headers: enTetes, body: JSON.stringify({ erreur: "L'analyse a pris trop de temps. Réessaie dans un instant." }) };
    }
    return { statusCode: 500, headers: enTetes, body: JSON.stringify({ erreur: "Impossible de contacter le service.", detail: String(e).slice(0, 200) }) };
  }
};
