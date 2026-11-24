// BioDex — fonction « notifier » (v1.95) : envoie les notifications push.
//
// Appelée par les déclencheurs de la base (pg_net) avec seulement { table, id }.
// Elle relit la ligne elle-même avec la clé de service, décide QUI prévenir, puis
// envoie le Web Push. Personne ne peut lui faire envoyer un texte arbitraire :
//   • elle n'accepte que 5 tables connues ;
//   • elle ignore les lignes de plus de 15 minutes ;
//   • chaque événement n'est envoyé qu'une fois (table push_journal).
// Secret attendu : VAPID_PRIVATE (posé par Sylvain dans Supabase → Edge Functions → Secrets).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC = "BMO7pu6kxglWutu_13ii2vlNmbU75RvjlVTBEIKn0n37X4eMIJX_OQR0Hc3Mtpt9sXV9Pd5imfaJFhR2zwPLlHU";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE") ?? "";
const SUJET = "https://lucanus.netlify.app";
const TABLES = ["suggestions", "commentaires", "reactions_detail", "defis_historique", "posts"];
const FRAICHEUR_MS = 15 * 60 * 1000;
const EMOJIS: Record<string, string> = { feu: "🔥", amour: "😍", waouh: "🤯", oeil: "🔍" };

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

type Envoi = { dest: string | null; tous?: boolean; exclure?: string | null; pref: string; titre: string; corps: string; tag: string; url: string };

const recent = (iso?: string | null) => !!iso && Date.now() - new Date(iso).getTime() < FRAICHEUR_MS;
const court = (s: unknown, n: number) => { const t = String(s ?? "").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

async function marquer(cle: string): Promise<boolean> {
  const { error } = await sb.from("push_journal").insert({ cle });
  return !error; // conflit de clé = déjà envoyé
}

async function construire(table: string, id: string): Promise<Envoi | null> {
  if (table === "suggestions") {
    const { data: s } = await sb.from("suggestions").select("id, owner_id, annonce, statut, created_at").eq("id", Number(id)).maybeSingle();
    if (!s || s.statut !== "envoyee" || !recent(s.created_at)) return null;
    return { dest: s.owner_id, pref: "suggestions", titre: "🦊 Une idée du relecteur",
      corps: `Sur ta ${court(s.annonce || "trouvaille", 60)}. Rien d'obligatoire : c'est toi qui décides.`, tag: "sugg-" + s.id, url: "./?notif=1" };
  }
  if (table === "commentaires") {
    const { data: c } = await sb.from("commentaires").select("id, post_id, auteur, texte, owner_id, created_at").eq("id", id).maybeSingle();
    if (!c || !recent(c.created_at)) return null;
    const { data: p } = await sb.from("posts").select("id, owner_id, espece").eq("id", c.post_id).maybeSingle();
    if (!p || !p.owner_id || p.owner_id === c.owner_id) return null;
    return { dest: p.owner_id, pref: "commentaires", titre: `💬 ${court(c.auteur || "Quelqu'un", 30)} a commenté`,
      corps: `Ta ${court(p.espece || "trouvaille", 50)} : « ${court(c.texte, 90)} »`, tag: "com-" + p.id, url: "./?notif=1" };
  }
  if (table === "reactions_detail") {
    const { data: r } = await sb.from("reactions_detail").select("id, post_id, type, auteur, owner_id, created_at").eq("id", id).maybeSingle();
    if (!r || !recent(r.created_at)) return null;
    const { data: p } = await sb.from("posts").select("id, owner_id, espece").eq("id", Number(r.post_id)).maybeSingle();
    if (!p || !p.owner_id || p.owner_id === r.owner_id) return null;
    // Au plus une notification de réaction par publication et par heure (pas de rafale).
    const heure = new Date().toISOString().slice(0, 13);
    if (!(await marquer(`react:${p.id}:${heure}`))) return null;
    return { dest: p.owner_id, pref: "reactions", titre: `${EMOJIS[r.type] || "❤️"} ${court(r.auteur || "Quelqu'un", 30)} a réagi`,
      corps: `à ta ${court(p.espece || "trouvaille", 60)}`, tag: "react-" + p.id, url: "./?notif=1" };
  }
  if (table === "defis_historique") {
    const { data: d } = await sb.from("defis_historique").select("id, defieur, defendeur, carte_nom, defieur_gagne, created_at").eq("id", id).maybeSingle();
    if (!d || !recent(d.created_at) || !d.defendeur) return null;
    const { data: carte } = await sb.from("cartes_ligue").select("owner_id").ilike("proprietaire", d.defendeur).not("owner_id", "is", null).limit(1).maybeSingle();
    let dest = carte?.owner_id ?? null;
    if (!dest) {
      const { data: prof } = await sb.from("profils").select("owner_id").ilike("prenom", d.defendeur).not("owner_id", "is", null).limit(1).maybeSingle();
      dest = prof?.owner_id ?? null;
    }
    if (!dest) return null;
    return { dest, pref: "defis", titre: `⚔️ ${court(d.defieur || "Quelqu'un", 30)} a défié ta ${court(d.carte_nom || "carte", 40)}`,
      corps: d.defieur_gagne ? "Elle a perdu ce combat… une revanche ?" : "Elle a tenu bon ! 🛡️", tag: "defi-" + d.id, url: "./?notif=1" };
  }
  if (table === "posts") {
    const { data: p } = await sb.from("posts").select("id, owner_id, auteur, espece, created_at").eq("id", Number(id)).maybeSingle();
    if (!p || !recent(p.created_at)) return null;
    return { dest: null, tous: true, exclure: p.owner_id, pref: "mur", titre: `🆕 ${court(p.auteur || "Quelqu'un", 30)} a partagé une trouvaille`,
      corps: p.espece ? court(p.espece, 80) : "Une bestiole à identifier : tu peux aider !", tag: "mur-" + p.id, url: "./?notif=mur" };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: true, service: "notifier" });
  let b: { table?: string; id?: string };
  try { b = await req.json(); } catch { return json({ ok: false, raison: "json" }, 400); }
  const table = String(b.table ?? ""), id = String(b.id ?? "").slice(0, 64);
  if (!TABLES.includes(table) || !id) return json({ ok: false, raison: "entree" }, 400);
  if (!VAPID_PRIVATE) return json({ ok: false, raison: "vapid_absent" }, 503);

  if (!(await marquer(`${table}:${id}`))) return json({ ok: true, envoyes: 0, raison: "deja" });
  const e = await construire(table, id);
  if (!e) return json({ ok: true, envoyes: 0 });

  let q = sb.from("push_abonnements").select("id, owner_id, endpoint, p256dh, auth, prefs");
  q = e.tous ? q.eq("prefs->>mur", "true") : q.eq("owner_id", e.dest!);
  const { data: abos } = await q.limit(500);
  webpush.setVapidDetails(SUJET, VAPID_PUBLIC, VAPID_PRIVATE);
  const charge = JSON.stringify({ titre: e.titre, corps: e.corps, tag: e.tag, url: e.url });
  let envoyes = 0;
  for (const a of abos ?? []) {
    if (e.exclure && a.owner_id === e.exclure) continue;
    if (a.prefs && a.prefs[e.pref] === false) continue;
    try {
      await webpush.sendNotification({ endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } }, charge, { TTL: 86400 });
      envoyes++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from("push_abonnements").delete().eq("id", a.id); // abonnement expiré
      else console.error("push", code, String((err as Error).message ?? err).slice(0, 200));
    }
  }
  return json({ ok: true, envoyes });
});
