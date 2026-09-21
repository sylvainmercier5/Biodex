// netlify/functions/identifier.js — v2.01
// Ajout v2.01 : champ « contact » (ça pique ?) dans identification, fiche et affinage.
// Ajouts v2.00 : budget IA mensuel, CORS restreint, modèles adaptés par tâche,
// nombre de tours d'affinage plafonné côté serveur.
// Fonction serverless BioDex : identification d'insecte + fiche naturaliste, via l'API Claude (Sonnet).
// La clé API vit UNIQUEMENT ici (variable d'environnement Netlify), jamais dans le navigateur.

// ── CHOIX DES MODÈLES (v2.00) ────────────────────────────────────────────
// Le bon modèle au bon endroit : c'est le premier levier sur la facture.
// VISION  : identification et affinage. Opus reste indispensable ici — c'est
//           la seule tâche où la précision décide de la valeur de l'appli.
const MODELE_VISION = process.env.BIODEX_MODELE_VISION || "claude-opus-4-8";
// FICHE   : la fiche naturaliste AFFIRME des faits (statut de conservation,
//           répartition, période de vol). On garde Sonnet : c'est le seul
//           texte où une approximation serait un mensonge.
const MODELE_FICHE  = process.env.BIODEX_MODELE_FICHE  || "claude-sonnet-5";
// CARTE   : stats de jeu inventées, aucun enjeu factuel. Haiku suffit.
const MODELE_CARTE  = process.env.BIODEX_MODELE_CARTE  || "claude-haiku-4-5";

// Tarifs publics, en dollars par million de tokens. Sert au calcul du budget.
// À remettre à jour si Anthropic change sa grille.
const TARIFS = {
  "claude-opus-4-8":  { entree: 5, sortie: 25 },
  "claude-opus-5":    { entree: 5, sortie: 25 },
  "claude-sonnet-5":  { entree: 2, sortie: 10 },
  "claude-haiku-4-5": { entree: 1, sortie: 5 },
};
// Si un modèle inconnu est configuré, on facture au tarif le plus cher :
// mieux vaut sur-réserver du budget que de le laisser filer.
const TARIF_DEFAUT = { entree: 5, sortie: 25 };
function tarif(modele) { return TARIFS[modele] || TARIF_DEFAUT; }

// Coût en MICRO-DOLLARS (1e-6 $) — même unité que la table ia_budget.
function microDollars(modele, tokensEntree, tokensSortie) {
  const t = tarif(modele);
  return Math.ceil(tokensEntree * t.entree + tokensSortie * t.sortie);
}
// Estimation d'une image avant envoi : formule officielle de facturation,
// ceil(l/28) x ceil(h/28). On ne connaît pas les dimensions réelles côté
// serveur, donc on prend le pire cas de ce que le client envoie (1024 px).
const TOKENS_IMAGE_MAX = Math.ceil(1024 / 28) * Math.ceil(1024 / 28); // 1369
// Un caractère de prompt ~ 1/3,8 token en français.
function tokensTexte(s) { return Math.ceil(String(s || "").length / 3.8); }

// ── GARDE-FOU BUDGÉTAIRE ─────────────────────────────────────────────────
// Deuxième couche de protection, après le plafond de dépense du workspace
// dans la console Claude. Celle-ci freine AVANT le mur, et permet un message
// clair à la personne au lieu d'une erreur brute.
const SB_URL = process.env.SUPABASE_URL || "";
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUDGET_ACTIF = Boolean(SB_URL && SB_SERVICE);

async function rpc(nom, corps) {
  const r = await fetch(SB_URL.replace(/\/$/, "") + "/rest/v1/rpc/" + nom, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SB_SERVICE,
      Authorization: "Bearer " + SB_SERVICE,
    },
    body: JSON.stringify(corps),
  });
  if (!r.ok) throw new Error("rpc " + nom + " : " + r.status);
  return r.json();
}

// Réserve le coût estimé. Renvoie null si le budget du mois est épuisé.
async function reserverBudget(micro) {
  if (!BUDGET_ACTIF) return { autorise: true, micro_restant: null }; // pas encore configuré
  try {
    const d = await rpc("reserver_budget_ia", { p_micro: micro });
    const l = Array.isArray(d) ? d[0] : d;
    return l && l.autorise ? l : null;
  } catch (e) {
    // Si Supabase est injoignable, on laisse passer : le plafond du workspace
    // reste derrière. Couper l'appli parce que le compteur est en panne
    // serait pire que le risque budgétaire.
    console.error("budget: réservation impossible, on laisse passer", String(e));
    return { autorise: true, micro_restant: null };
  }
}
// Corrige la réservation avec la consommation réelle (delta négatif le plus souvent).
async function ajusterBudget(delta) {
  if (!BUDGET_ACTIF || !delta) return;
  try { await rpc("ajuster_budget_ia", { p_delta: Math.round(delta) }); }
  catch (e) { console.error("budget: ajustement impossible", String(e)); }
}

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

// Origines autorisées à appeler cette fonction. Sans ça, n'importe quel site
// du web pouvait faire tourner l'IA sur TON budget depuis le navigateur de
// ses visiteurs. Variable Netlify BIODEX_ORIGINES, séparées par des virgules.
const ORIGINES = (process.env.BIODEX_ORIGINES || "https://lucanus.netlify.app")
  .split(",").map((o) => o.trim()).filter(Boolean);

exports.handler = async (event) => {
  const origine = (event.headers && (event.headers.origin || event.headers.Origin)) || "";
  // Une TWA Android envoie l'origine du site ; une requête sans origine
  // (curl, appli native) est acceptée ici mais reste soumise au quota et au budget.
  const origineOk = !origine || ORIGINES.includes(origine);
  const enTetes = {
    "Access-Control-Allow-Origin": origineOk && origine ? origine : ORIGINES[0],
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };

  if (!origineOk) {
    return { statusCode: 403, headers: enTetes, body: JSON.stringify({ erreur: "Origine non autorisée." }) };
  }

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
    if (c.taille) ctx.push("Taille réelle estimée du spécimen : " + String(c.taille).slice(0, 30) + " (critère morphométrique fort — écarte les espèces dont la taille adulte est incompatible avec cette fourchette)");
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
    // Le prompt DEMANDE de conclure au bout de 3 questions, mais rien ne l'y
    // obligeait : l'affinage est le poste le plus cher (photo renvoyée à
    // chaque tour, sur le modèle vision). On plafonne ici, pour de vrai.
    const MAX_TOURS = 3;
    const historique = Array.isArray(corps.historique) ? corps.historique.slice(0, MAX_TOURS) : [];
    const nbPoses = historique.length;
    const doitConclure = nbPoses >= MAX_TOURS;
    systeme =
      "Tu es un entomologiste qui mène une clé de détermination interactive avec l'observateur. " +
      "Tu disposes de la photo et des réponses déjà données. Ton but : converger vers l'identification la plus précise possible. " +
      "À chaque tour, DEUX possibilités :\n" +
      "1) S'il reste une ambiguïté que l'observateur peut lever, pose UNE seule question ciblée sur un critère observable à l'œil " +
      "(antennes, pattes, taille réelle, motif, comportement, plante-hôte...). Propose 2 à 4 réponses courtes et exclusives. " +
      "2) Si tu es désormais suffisamment sûr, OU si tu as déjà posé " + (doitConclure ? "assez de" : "plusieurs") + " questions, conclus par une identification finale. " +
      (doitConclure ? "Tu as atteint le nombre maximum de questions : tu DOIS conclure maintenant par une identification finale. " : "") +
      "Réponds UNIQUEMENT par un objet JSON valide, sans texte ni Markdown autour :\n" +
      'soit {"type":"question","question":"...","options":["...","..."],"pourquoi":"ce que ce critère permet de trancher"}\n' +
      'soit {"type":"final","nom":"nom vernaculaire FR","nomSci":"binôme latin","confiance":un nombre entier de 0 à 100 exprimant ton pourcentage de certitude réel,"niveau":"espèce|genre|famille|ordre","note":"synthèse de la détermination","contact":"inoffensif|defensif|douloureux|urticant|inconnu (dans le doute, le plus élevé)","contact_note":"conseil de manipulation en une phrase, vide si inoffensif"}. ' +
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
    // Si une photo est fournie, évalue aussi son authenticité (vraie photo terrain vs image web/capture/dessin).
    const nom = String(corps.nom || "").slice(0, 120);
    const nomSci = String(corps.nomSci || "").slice(0, 120);
    const aImage = corps.image && corps.media_type;
    systeme =
      "Tu es le game designer d'un jeu de cartes à collectionner sur les insectes. " +
      "À partir d'une espèce réelle, tu génères une carte de combat équilibrée dont les stats reflètent la BIOLOGIE réelle de l'animal " +
      "(un lucane a une forte attaque via ses mandibules ; un scarabée une bonne défense via sa cuirasse ; une libellule une grande vitesse ; " +
      "une espèce rare/protégée a une rareté élevée). " +
      "Barème : chaque stat de 1 à 100, équilibrées pour que la SOMME attaque+defense+vitesse soit proche de 150 (ni trop faible, ni surpuissant). " +
      "La rareté (1 à 100) reflète la rareté réelle et le statut de conservation. " +
      "La capacité spéciale est un pouvoir de jeu court inspiré d'un trait réel de l'espèce (vol stationnaire, camouflage, stridulation, dard, bioluminescence, mimétisme...). " +
      "Le type de combat doit refléter la nature de l'insecte et être choisi STRICTEMENT parmi ces 8 valeurs : " +
      "volant (papillons, libellules, mouches), cuirasse (coléoptères, scarabées à carapace), rampant (chenilles, mille-pattes, vers), " +
      "bondissant (sauterelles, criquets, grillons), venimeux (araignées, guêpes, frelons), aquatique (insectes d'eau, larves aquatiques), " +
      "social (fourmis, abeilles, termites en colonie), nocturne (papillons de nuit, blattes, perce-oreilles). " +
      (aImage
        ? "IMPORTANT — AUTHENTICITÉ : on te fournit la photo qui a servi à créer la carte. Évalue si c'est vraisemblablement une VRAIE photographie d'insecte prise sur le terrain par un amateur, " +
          "ou au contraire une image suspecte : capture d'écran (interface, texte, curseur visibles), dessin ou illustration, image de synthèse, ou photo manifestement issue du web/studio (fond blanc parfait, qualité pro irréaliste). " +
          "Sois indulgent : dans le doute, considère la photo comme authentique (authentique=true). Ne signale (authentique=false) que les cas MANIFESTES. " +
          'Ajoute au JSON les champs "authentique":true/false et "authenticite_raison":"courte raison si false, sinon vide". '
        : "") +
      "Réponds UNIQUEMENT par un objet JSON valide, sans texte ni Markdown : " +
      '{"attaque":N,"defense":N,"vitesse":N,"rarete":N,' +
      '"element":"un des 8 types : volant, cuirasse, rampant, bondissant, venimeux, aquatique, social ou nocturne",' +
      '"capacite":{"nom":"nom court de la capacité","effet":"effet de jeu en une phrase",' +
      '"famille":"la famille d\'effet la plus cohérente avec la biologie de l\'espèce, parmi exactement : frappe (attaque brute), regen (l\'insecte se soigne/régénère/mue), sonne (il étourdit, paralyse, aveugle ou désoriente sa proie), drain (il aspire, absorbe, vampirise ou épuise sa cible). Choisis frappe si aucune autre ne colle vraiment."},' +
      (aImage ? '"authentique":true,"authenticite_raison":"",' : "") +
      '"citation":"une phrase d\'ambiance évocatrice sur l\'espèce (max 15 mots)"}';
    const contenu = [{ type: "text", text: "Crée la carte de : " + nom + (nomSci ? " (" + nomSci + ")" : "") + "." }];
    if (aImage) contenu.push({ type: "image", source: { type: "base64", media_type: corps.media_type, data: corps.image } });
    messages = [{ role: "user", content: contenu }];
    maxTokens = 450;
  } else if (mode === "fiche") {
    // Génération d'une fiche naturaliste à partir d'un nom déjà identifié
    const nom = String(corps.nom || "").slice(0, 120);
    const nomSci = String(corps.nomSci || "").slice(0, 120);
    systeme =
      "Tu es un entomologiste francophone rigoureux et pédagogue, sensible à la protection de la biodiversité. On te donne une espèce (ou un taxon) déjà identifiée. " +
      "Rédige une fiche naturaliste synthétique et fiable, en français. " +
      "IMPORTANT sur le statut de conservation : les listes rouges évoluent et tu ne peux pas les vérifier en temps réel. " +
      "N'affirme JAMAIS un statut avec certitude : donne une indication prudente et signale qu'elle doit être vérifiée. " +
      "Si tu n'es pas sûr d'un champ, mets une valeur honnête comme \"variable\", \"mal connu\" ou \"à vérifier\" plutôt que d'inventer. " +
      "Pour le champ 'role_ecosysteme', explique concrètement pourquoi cet insecte compte dans son écosystème (pollinisation, décomposition/recyclage de matière, régulation d'autres populations, source de nourriture pour oiseaux/chauves-souris, bio-indicateur de la qualité d'un milieu...). Reste factuel et valorisant sans exagérer. " +
      "Pour le champ 'geste', propose UNE action simple et concrète que n'importe qui peut faire pour aider cette espèce ou son groupe (laisser un coin de jardin sauvage, éviter les pesticides, installer un point d'eau, laisser du bois mort, planter des fleurs mellifères...). Si l'espèce est nuisible ou invasive, adapte le conseil honnêtement. " +
      "Réponds UNIQUEMENT par un objet JSON valide, sans texte ni Markdown autour, de la forme exacte : " +
      '{"description":"2-3 phrases : allure générale, taille, traits distinctifs",' +
      '"alimentation":"régime de l\'adulte et de la larve si pertinent",' +
      '"periode":"période d\'apparition / mois de vol des adultes",' +
      '"habitat":"habitats et biotopes typiques",' +
      '"repartition":"répartition géographique générale (France/Europe si pertinent)",' +
      '"conservation":"statut indicatif et prudent, ex : \'apparemment commun, à vérifier\' ou \'espèce protégée en France, à confirmer\'",' +
      '"role_ecosysteme":"pourquoi cet insecte compte : son rôle écologique concret, 1-2 phrases valorisantes et justes",' +
      '"geste":"une action simple et concrète pour l\'aider, formulée de façon encourageante (1 phrase)",' +
      '"faits":"un ou deux faits marquants ou remarquables",' +
      '"contact":"UN mot parmi exactement : inoffensif (se manipule sans risque), defensif (peut piquer, mordre ou pincer si on le manipule), douloureux (piqûre ou morsure douloureuse, ne pas manipuler), urticant (poils ou sécrétions irritants, ne pas toucher), inconnu. Sois prudent : dans le doute entre deux niveaux, choisis le plus élevé.",' +
      '"contact_note":"une phrase courte et concrète de conseil de manipulation (ex : Ne le prends pas dans la main, sa piqûre est douloureuse), vide si inoffensif",' +
      '"fiabilite":"élevée|moyenne|faible — ta confiance globale dans cette fiche selon que le taxon est commun/bien connu ou non"}';
    messages = [{ role: "user", content: [{ type: "text", text: "Espèce à documenter : " + nom + (nomSci ? " (" + nomSci + ")" : "") + "." }] }];
    maxTokens = 1180;
  } else {
    // Identification poussée à partir d'UNE OU PLUSIEURS photos (angles différents).
    // Rétrocompatible : accepte l'ancien format { image, media_type } ou le nouveau { images: [{data, media_type}] }.
    const photos = Array.isArray(corps.images) && corps.images.length
      ? corps.images.filter((p) => p && p.data && p.media_type).slice(0, 3)
      : (corps.image && corps.media_type ? [{ data: corps.image, media_type: corps.media_type }] : []);
    if (!photos.length) {
      return { statusCode: 400, headers: enTetes, body: JSON.stringify({ erreur: "Image manquante." }) };
    }
    systeme =
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
    const contenuId = photos.map((p) => ({ type: "image", source: { type: "base64", media_type: p.media_type, data: p.data } }));
    contenuId.push({
      type: "text",
      text: (photos.length > 1
        ? "Identifie cet arthropode. Les " + photos.length + " photos montrent le MÊME individu sous des angles différents : croise-les."
        : "Identifie cet arthropode.") + blocCtx,
    });
    messages = [{ role: "user", content: contenuId }];
    maxTokens = 780;
  }

  // Choix du modèle, poste par poste (voir l'en-tête pour le raisonnement).
  const modeleUtilise = mode === "fiche" ? MODELE_FICHE
                      : mode === "carte" ? MODELE_CARTE
                      : MODELE_VISION;

  // ── Réservation du budget ──────────────────────────────────────────────
  // On estime haut : nombre d'images x pire cas, plus le prompt système, plus
  // max_tokens en sortie. On corrigera vers le bas avec la conso réelle.
  const nbImages = messages.reduce(
    (n, m) => n + (Array.isArray(m.content) ? m.content.filter((b) => b.type === "image").length : 0), 0);
  const tokensEntreeEstimes = tokensTexte(systeme)
    + nbImages * TOKENS_IMAGE_MAX
    + messages.reduce((n, m) => n + (Array.isArray(m.content)
        ? m.content.filter((b) => b.type === "text").reduce((s, b) => s + tokensTexte(b.text), 0) : 0), 0);
  const microEstime = microDollars(modeleUtilise, tokensEntreeEstimes, maxTokens);

  const reservation = await reserverBudget(microEstime);
  if (!reservation) {
    return {
      statusCode: 429,
      headers: enTetes,
      body: JSON.stringify({
        erreur: "L'enveloppe d'identifications du mois est épuisée. Elle se recharge le 1er du mois prochain.",
        budget_epuise: true,
      }),
    };
  }

  try {
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), 25000); // 25 s max
    let reponse;
    try {
      reponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": cle, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: modeleUtilise, max_tokens: maxTokens, system: systeme, messages }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(minuteur);
    }

    if (!reponse.ok) {
      const txt = await reponse.text();
      // Appel refusé : rien n'a été facturé, on rend la réservation.
      await ajusterBudget(-microEstime);
      // 429 côté Anthropic = plafond de dépense du workspace atteint.
      // C'est le mur dur : on le traduit en message compréhensible.
      if (reponse.status === 429) {
        return { statusCode: 429, headers: enTetes, body: JSON.stringify({
          erreur: "Le service d'identification a atteint sa limite mensuelle. Il repart le 1er du mois prochain.",
          budget_epuise: true,
        }) };
      }
      return { statusCode: 502, headers: enTetes, body: JSON.stringify({ erreur: "L'API a renvoyé une erreur.", detail: txt.slice(0, 300) }) };
    }

    const data = await reponse.json();

    // Consommation réelle : on remplace l'estimation par le chiffre exact.
    if (data && data.usage) {
      const microReel = microDollars(
        modeleUtilise,
        (data.usage.input_tokens || 0) + (data.usage.cache_read_input_tokens || 0),
        data.usage.output_tokens || 0
      );
      await ajusterBudget(microReel - microEstime);
    }
    const texte = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();

    let resultat = null;
    try {
      const propre = texte.replace(/```json/gi, "").replace(/```/g, "").trim();
      resultat = JSON.parse(propre);
    } catch {
      if (mode === "fiche") resultat = { description: texte.slice(0, 500), fiabilite: "faible" };
      else if (mode === "carte") resultat = { attaque: 50, defense: 50, vitesse: 50, rarete: 30, element: "Rampant", capacite: { nom: "Instinct", effet: "Aucun effet particulier." }, citation: "" };
      else resultat = { nom: "", nomSci: "", confiance: 0, niveau: "", note: texte.slice(0, 300), alternatives: [] };
    }

    return { statusCode: 200, headers: enTetes, body: JSON.stringify({ ok: true, mode, resultat }) };
  } catch (e) {
    // Échec réseau ou délai dépassé : on ne sait pas si Anthropic a facturé.
    // On rend la moitié de la réservation — prudent sans être punitif.
    await ajusterBudget(-Math.round(microEstime / 2));
    if (e && e.name === "AbortError") {
      return { statusCode: 504, headers: enTetes, body: JSON.stringify({ erreur: "L'analyse a pris trop de temps. Réessaie dans un instant." }) };
    }
    return { statusCode: 500, headers: enTetes, body: JSON.stringify({ erreur: "Impossible de contacter le service.", detail: String(e).slice(0, 200) }) };
  }
};
