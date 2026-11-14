/**
 * content.js : s'exécute sur projetvoltaire.fr
 *
 * Principe : l'extension ne répond JAMAIS à ta place et ne clique sur rien.
 * Elle observe la page ; quand le site t'indique une erreur, elle :
 *   1. identifie la règle concernée (matcher.js + data/regles.json),
 *   2. t'explique la règle dans un panneau flottant,
 *   3. te pose des questions pour vérifier que tu as compris,
 *   4. note la règle dans ton carnet (stocké en local) et te la fait réviser
 *      plus tard avec une répétition espacée (système de Leitner simplifié).
 *
 * Raccourci : Alt+E (sélectionne un passage avant, ou ouvre la recherche).
 */
(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  const Matcher = globalThis.VoltaireMatcher;
  if (!Matcher) {
    console.error("[Voltaire Coach] matcher.js introuvable.");
    return;
  }

  /* ------------------------------------------------------------------ */
  /* Configuration : À ADAPTER selon le DOM réel du site (voir README)   */
  /* ------------------------------------------------------------------ */
  const CONFIG = {
    // Mots qui signalent une erreur dans le retour affiché par le site.
    // (L'interface est générée en JS : on se base sur le TEXTE, pas sur les classes.)
    indicesErreur: [
      /\bfaux\b/i,
      /\bincorrect/i,
      /\bdommage\b/i,
      /mauvaise r[ée]ponse/i,
      /\berreur\b/i,
      /pas tout [àa] fait/i
    ],
    delaiAntiRebond: 400, // ms
    periodeSondage: 2000, // ms
    tailleMaxTexte: 1500, // taille max du bloc qui signale l'erreur
    // Contexte : on remonte dans le DOM jusqu'à avoir assez de texte
    // (phrase + correction), sans dépasser la taille max.
    tailleContexteMin: 200,
    tailleContexteMax: 2500,
    // Intervalles de révision en jours, selon la « boîte » (Leitner).
    intervallesJours: [0, 1, 3, 7, 21, 60]
  };

  /* ------------------------------ État ------------------------------- */
  let regles = [];
  let mots = []; // mots pièges (data/mots.json)
  let dernierContexte = ""; // dernier texte analysé (envoyé à l'IA seulement sur clic)
  let carnet = {}; // { idRegle: { erreurs, boite, prochaine, derniere } }
  let derniereSignature = "";

  /* ----------------------------- Utilitaires ------------------------- */
  const maintenant = () => Date.now();
  const JOUR = 86_400_000;

  /** Mélange de Fisher-Yates (renvoie une copie). */
  function melanger(iterable) {
    const t = [...iterable];
    for (let i = t.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [t[i], t[j]] = [t[j], t[i]];
    }
    return t;
  }

  /**
   * Création d'éléments DOM sans innerHTML (les chaînes deviennent du texte,
   * donc rien du site ne peut être interprété comme du HTML).
   */
  function h(balise, attrs = {}, ...enfants) {
    const el = document.createElement(balise);
    for (const [cle, val] of Object.entries(attrs)) {
      if (cle === "class") el.className = val;
      else if (cle.startsWith("on") && typeof val === "function") {
        el.addEventListener(cle.slice(2), val);
      } else el.setAttribute(cle, val);
    }
    for (const e of enfants.flat(Infinity)) if (e != null) el.append(e);
    return el;
  }

  /* ------------------------------ Stockage --------------------------- */
  async function chargerEtat() {
    try {
      regles = (await api.runtime.sendMessage({ type: "getRules" })) ?? [];
      mots = (await api.runtime.sendMessage({ type: "getWords" })) ?? [];
    } catch (e) {
      console.error("[Voltaire Coach] Règles indisponibles :", e);
    }
    try {
      carnet = (await api.storage.local.get("carnet")).carnet ?? {};
      // Règles proposées par l'IA lors de sessions précédentes.
      const ia = (await api.storage.local.get("reglesIA")).reglesIA ?? {};
      for (const r of Object.values(ia)) if (r?.id && !regleParId(r.id)) regles.push(r);
    } catch (e) {
      console.error("[Voltaire Coach] Carnet illisible :", e);
    }
  }

  async function sauvegarder() {
    try {
      await api.storage.local.set({ carnet });
    } catch (e) {
      console.error("[Voltaire Coach] Sauvegarde impossible :", e);
    }
  }

  const regleParId = (id) => regles.find((r) => r.id === id);
  const reglesDues = () =>
    regles.filter((r) => carnet[r.id] && carnet[r.id].prochaine <= maintenant());

  /** Une erreur vient d'être constatée sur cette règle. */
  async function enregistrerErreur(id) {
    const e = carnet[id] ?? { erreurs: 0, boite: 0, prochaine: 0, derniere: 0 };
    e.erreurs += 1;
    e.boite = 0;
    e.derniere = maintenant();
    e.prochaine = maintenant() + 10 * 60_000; // à revoir dans 10 minutes
    carnet[id] = e;
    await sauvegarder();
  }

  /** Mise à jour de la boîte après un quiz : succès = on monte, échec = retour au début. */
  function majLeitner(id, reussite) {
    let e = carnet[id];
    if (!e) {
      if (reussite) return; // règle jamais ratée : rien à suivre
      e = { erreurs: 1, boite: 0, prochaine: 0, derniere: 0 };
    }
    const max = CONFIG.intervallesJours.length - 1;
    e.boite = reussite ? Math.min(e.boite + 1, max) : 0;
    e.prochaine =
      e.boite === 0
        ? maintenant() + 10 * 60_000
        : maintenant() + CONFIG.intervallesJours[e.boite] * JOUR;
    e.derniere = maintenant();
    carnet[id] = e;
  }

  /* ------------------------- Orthographe d'usage ---------------------- */
  // Les mots du carnet sont stockés avec l'identifiant « mot:<mot> ».
  const motsId = (mot) => `mot:${mot}`;
  const estMot = (id) => id.startsWith("mot:");
  const motsDus = () =>
    Object.entries(carnet)
      .filter(([id, e]) => estMot(id) && e.prochaine <= maintenant())
      .map(([id]) => id.slice(4));
  const astuceDe = (mot) => mots.find((x) => x.mot === mot)?.astuce ?? "";

  /** Ajoute (ou renforce) un mot dans le carnet. Renvoie false si le mot est invalide. */
  async function ajouterMot(brut) {
    const mot = String(brut ?? "").normalize("NFC").trim().toLowerCase();
    if (!/^[\p{L}-]{2,40}$/u.test(mot)) return false;
    const id = motsId(mot);
    const e = carnet[id] ?? { erreurs: 0, boite: 0, prochaine: 0, derniere: 0 };
    e.erreurs += 1;
    e.boite = 0;
    e.derniere = maintenant();
    e.prochaine = maintenant() + 10 * 60_000;
    carnet[id] = e;
    await sauvegarder();
    return true;
  }

  /** Question « Quelle est la bonne orthographe ? » avec de fausses variantes. */
  function questionMot(mot) {
    const astuce = astuceDe(mot);
    return {
      q: "Quelle est la bonne orthographe ?",
      choix: [mot, ...Matcher.genererVariantes(mot, 3)],
      reponse: 0,
      explication: astuce ? `« ${mot} » : ${astuce}` : `La bonne orthographe est « ${mot} ».`
    };
  }

  const itemMot = (mot) => ({
    regle: { id: motsId(mot), categorie: "Orthographe", titre: mot },
    q: questionMot(mot)
  });

  /** Ligne « à relire » dans le bilan : règle ou mot. */
  const ligneRelire = (id) =>
    estMot(id)
      ? h("div", { class: "ex" }, h("strong", {}, id.slice(4)), h("p", {}, astuceDe(id.slice(4)) || "À retenir."))
      : ligneRegle(regleParId(id));

  /** Bloc « Mots à surveiller dans cette phrase ». */
  const blocMots = (liste) =>
    liste?.length
      ? h(
          "div",
          {},
          h("p", { class: "note" }, "Mots à surveiller dans cette phrase :"),
          liste.map(({ mot, astuce }) =>
            h(
              "div",
              { class: "ex" },
              h("strong", {}, mot),
              h("p", {}, astuce),
              h(
                "div",
                { class: "actions" },
                h(
                  "button",
                  {
                    onclick: async (ev) => {
                      const b = ev.currentTarget;
                      if (await ajouterMot(mot)) {
                        b.textContent = "Ajouté ✓";
                        b.disabled = true;
                      }
                    }
                  },
                  "Retenir"
                ),
                h("button", { onclick: () => lancerQuiz([itemMot(mot)], () => vueAccueil()) }, "Me tester")
              )
            )
          )
        )
      : null;

  /** Petit formulaire pour noter un mot à retenir. */
  function formulaireMot() {
    const champ = h("input", { type: "text", placeholder: "Mot à retenir (bonne orthographe)" });
    const bouton = h(
      "button",
      {
        onclick: async () => {
          const ok = await ajouterMot(champ.value);
          bouton.textContent = ok ? "Ajouté ✓" : "Mot invalide";
          if (ok) champ.value = "";
          setTimeout(() => (bouton.textContent = "Ajouter"), 1500);
        }
      },
      "Ajouter"
    );
    return h("div", {}, h("p", { class: "note" }, "Noter un mot à retenir :"), champ, h("div", { class: "actions" }, bouton));
  }

  /* ----------------------- Aide de l'IA (OpenRouter) ------------------ */
  const CATEGORIES_OK = ["Grammaire", "Orthographe", "Conjugaison", "Accords", "Homophones", "Expression"];
  const nettoyer = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

  const MESSAGES_IA = {
    ia_desactivee: "L'aide de l'IA n'est pas activée. Ouvre les réglages pour entrer ta clé OpenRouter.",
    permission: "Autorisation manquante : ouvre les réglages et enregistre-les à nouveau.",
    http_401: "Clé API refusée par OpenRouter.",
    http_402: "Crédit OpenRouter insuffisant.",
    http_404: "Modèle introuvable : vérifie son nom dans les réglages.",
    http_429: "Trop de requêtes, réessaie dans un instant.",
    delai: "OpenRouter met trop de temps à répondre : essaie un modèle plus rapide dans les réglages.",
    reseau: "OpenRouter est injoignable.",
    reponse_invalide: "La réponse de l'IA n'était pas exploitable."
  };

  /**
   * Transforme la réponse (non fiable) de l'IA en règle locale, après validation
   * stricte. Renvoie null si la réponse est incomplète ou incohérente.
   */
  function regleDepuisIA(d) {
    const titre = nettoyer(d?.titre, 80);
    const explication = nettoyer(d?.explication, 600);
    const q = d?.quiz;
    const choix = Array.isArray(q?.choix) ? q.choix.map((x) => nettoyer(String(x), 80)) : [];
    const quizValide =
      nettoyer(q?.q, 200) &&
      choix.length >= 2 &&
      choix.length <= 4 &&
      choix.every(Boolean) &&
      Number.isInteger(q.reponse) &&
      q.reponse >= 0 &&
      q.reponse < choix.length;
    if (!titre || !explication || !quizValide) return null;
    const faux = nettoyer(d.exemple_faux, 200);
    const juste = nettoyer(d.exemple_juste, 200);
    return {
      id: "ia-" + Matcher.normaliser(titre).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40),
      titre,
      categorie: CATEGORIES_OK.includes(d.categorie) ? d.categorie : "Grammaire",
      mots_cles: [],
      explication,
      astuce: nettoyer(d.astuce, 300),
      exemples: faux && juste ? [{ faux, juste }] : [],
      quiz: [{ q: nettoyer(q.q, 200), choix, reponse: q.reponse, explication: nettoyer(q.explication, 300) || "À retenir." }]
    };
  }

  async function memoriserRegleIA(regle) {
    const ia = (await api.storage.local.get("reglesIA")).reglesIA ?? {};
    ia[regle.id] = regle;
    await api.storage.local.set({ reglesIA: ia });
  }

  function vueErreurIA(code, detail = "") {
    afficher([
      h("p", {}, MESSAGES_IA[code] ?? `Erreur (${code}).`),
      detail ? h("p", { class: "note" }, `Détail : ${detail}`) : null,
      h(
        "div",
        { class: "actions" },
        h("button", { class: "principal", onclick: () => api.runtime.sendMessage({ type: "openOptions" }) }, "Réglages"),
        h("button", { onclick: () => vueAccueil() }, "Accueil")
      )
    ]);
  }

  /** Envoie le dernier texte analysé à OpenRouter (via le background), sur clic uniquement. */
  async function demanderALIA() {
    afficher([h("p", { class: "note" }, "🤖 Analyse en cours…")]);
    try {
      const rep = await Promise.race([
        api.runtime.sendMessage({
          type: "askAI",
          texte: dernierContexte.slice(0, 900),
          regles: regles.filter((r) => !r.id.startsWith("ia-")).map((r) => ({ id: r.id, titre: r.titre }))
        }),
        new Promise((_, rejet) => setTimeout(() => rejet(new Error("délai")), 40_000))
      ]);
      if (rep?.erreur) return vueErreurIA(rep.erreur, rep.detail);
      const d = rep?.data;
      const locale = typeof d?.regle_id === "string" ? regleParId(d.regle_id) : null;
      const regle = locale ?? regleDepuisIA(d);
      if (!regle) return vueErreurIA("reponse_invalide");
      if (!locale) {
        if (!regleParId(regle.id)) regles.push(regle);
        await memoriserRegleIA(regle);
      }
      await enregistrerErreur(regle.id);
      vueRegle(regle, [], Matcher.trouverMotsPieges(dernierContexte, mots));
    } catch (e) {
      console.error("[Voltaire Coach] Aide IA :", e);
      vueErreurIA(e?.message === "délai" ? "delai" : "reseau");
    }
  }

  const boutonIA = () => h("button", { onclick: demanderALIA }, "🤖 Demander à l'IA");

  /* --------------------------- Interface (Shadow DOM) ---------------- */
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, sans-serif; }
    .fab { position: fixed; right: 16px; bottom: 16px; width: 48px; height: 48px;
      border-radius: 50%; border: none; background: #1f3a8a; color: #fff;
      font-size: 22px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3);
      z-index: 2147483647; }
    .panneau { position: fixed; right: 16px; bottom: 76px; width: 360px;
      max-width: calc(100vw - 32px); max-height: 70vh; display: flex;
      flex-direction: column; background: #fff; color: #1a1a1a;
      border: 1px solid #c9ced6; border-radius: 12px;
      box-shadow: 0 6px 24px rgba(0,0,0,.25); z-index: 2147483647; }
    .panneau[hidden] { display: none; }
    header { display: flex; justify-content: space-between; align-items: center;
      padding: 10px 14px; background: #1f3a8a; color: #fff;
      border-radius: 11px 11px 0 0; }
    .x { background: none; border: none; color: #fff; font-size: 20px; cursor: pointer; }
    .corps { padding: 12px 14px; overflow-y: auto; font-size: 14px; line-height: 1.45; }
    h2 { font-size: 17px; margin: 6px 0; }
    p { margin: 6px 0; }
    input[type=search], input[type=text] { width: 100%; padding: 8px; border: 1px solid #aab; border-radius: 6px; font-size: 14px; }
    button { font-size: 14px; padding: 7px 12px; border-radius: 6px; border: 1px solid #1f3a8a;
      background: #fff; color: #1f3a8a; cursor: pointer; }
    button.principal { background: #1f3a8a; color: #fff; }
    .actions { display: flex; gap: 8px; margin: 10px 0; flex-wrap: wrap; }
    .liste { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
    .ligne { text-align: left; border-color: #d5d9e0; color: #1a1a1a; }
    .ligne small { color: #667; display: block; }
    .badge { display: inline-block; font-size: 11px; background: #e6ebff; color: #1f3a8a;
      border-radius: 10px; padding: 2px 8px; }
    .astuce { background: #fff7d6; border-radius: 6px; padding: 6px 8px; }
    .ex { border-left: 3px solid #d5d9e0; padding-left: 8px; margin: 8px 0; }
    .faux { color: #b3261e; } .juste { color: #1b6e2d; }
    .note { color: #556; font-size: 13px; }
    textarea { width: 100%; font-size: 12px; margin: 6px 0; }
    summary { cursor: pointer; }
    .choix { display: block; width: 100%; text-align: left; margin: 5px 0; color: #1a1a1a; border-color: #aab; }
    .choix.bon { background: #d9f2de; border-color: #1b6e2d; }
    .choix.mauvais { background: #fbdcd9; border-color: #b3261e; }
  `;

  const hote = h("div", { id: "voltaire-coach-hote" });
  const ombre = hote.attachShadow({ mode: "closed" });
  const panneau = h("section", { class: "panneau", hidden: "" });
  const bouton = h(
    "button",
    { class: "fab", title: "Voltaire Coach (Alt+E)", onclick: () => basculer() },
    "📘"
  );
  ombre.append(h("style", {}, CSS), bouton, panneau);
  // On évite que les raccourcis clavier du site interceptent la saisie.
  for (const evt of ["keydown", "keyup", "keypress"]) {
    hote.addEventListener(evt, (e) => e.stopPropagation());
  }

  const ouvrir = () => (panneau.hidden = false);
  const fermer = () => (panneau.hidden = true);
  const basculer = () => {
    if (panneau.hidden) {
      ouvrir();
      if (!panneau.childElementCount) vueAccueil();
    } else fermer();
  };

  /** Affiche un contenu dans le panneau (avec l'en-tête). */
  function afficher(contenu) {
    panneau.replaceChildren(
      h(
        "header",
        {},
        h("strong", {}, "Voltaire Coach"),
        h("button", { class: "x", "aria-label": "Fermer", onclick: fermer }, "×")
      ),
      h("div", { class: "corps" }, contenu)
    );
    ouvrir();
  }

  const ligneRegle = (r) =>
    h(
      "button",
      { class: "ligne", onclick: () => vueRegle(r) },
      r.titre,
      h("small", {}, r.categorie)
    );

  /* ------------------------------- Vues ------------------------------ */
  function vueAccueil(requete = "", message = "", diagnostic = "", pieges = []) {
    const resultats = h("div", { class: "liste" });
    const champ = h("input", {
      type: "search",
      placeholder: "Chercher une règle (ex. participe passé)",
      value: requete
    });
    const maj = () => {
      const q = champ.value.trim();
      const liste = q
        ? Matcher.trouverRegles(q, regles, 8).map((c) => c.regle)
        : regles;
      resultats.replaceChildren(
        ...(liste.length
          ? liste.map(ligneRegle)
          : [h("p", { class: "note" }, "Aucune règle trouvée.")])
      );
    };
    champ.addEventListener("input", maj);
    afficher([
      message ? h("p", { class: "note" }, message) : null,
      diagnostic
        ? h(
            "details",
            {},
            h("summary", { class: "note" }, "Texte analysé (à copier si besoin)"),
            h("textarea", { readonly: "", rows: "6" }, diagnostic),
            h("button", { onclick: () => navigator.clipboard?.writeText(diagnostic) }, "Copier")
          )
        : null,
      blocMots(pieges),
      champ,
      h(
        "div",
        { class: "actions" },
        h("button", { onclick: () => vueRevision() }, `Réviser (${reglesDues().length + motsDus().length})`),
        h("button", { onclick: () => vueCarnet() }, "Mon carnet"),
        dernierContexte ? boutonIA() : null,
        h("button", { title: "Réglages de l'IA", onclick: () => api.runtime.sendMessage({ type: "openOptions" }) }, "⚙️")
      ),
      formulaireMot(),
      resultats
    ]);
    maj();
    champ.focus();
  }

  function vueRegle(regle, autres = [], pieges = []) {
    afficher([
      h("span", { class: "badge" }, regle.categorie),
      h("h2", {}, regle.titre),
      regle.id.startsWith("ia-") ? h("p", { class: "note" }, "🤖 Règle proposée par l'IA : à vérifier.") : null,
      h("p", {}, regle.explication),
      regle.astuce ? h("p", { class: "astuce" }, "💡 " + regle.astuce) : null,
      ...regle.exemples.map((e) =>
        h(
          "div",
          { class: "ex" },
          h("p", { class: "faux" }, "✗ " + e.faux),
          h("p", { class: "juste" }, "✓ " + e.juste)
        )
      ),
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            class: "principal",
            onclick: () =>
              lancerQuiz(
                melanger(regle.quiz).map((q) => ({ regle, q })),
                () => vueRegle(regle, autres, pieges)
              )
          },
          "Me tester"
        ),
        h("button", { onclick: () => vueAccueil() }, "Accueil"),
        dernierContexte ? boutonIA() : null
      ),
      autres.length
        ? h(
            "div",
            {},
            h("p", { class: "note" }, "Autres règles possibles :"),
            h("div", { class: "liste" }, autres.map(ligneRegle))
          )
        : null,
      blocMots(pieges),
      regle.categorie === "Orthographe" ? formulaireMot() : null
    ]);
  }

  /**
   * Quiz : items = [{ regle, q }]. À la fin, le carnet est mis à jour.
   * `retour` est appelé quand on clique sur « Terminer ».
   */
  function lancerQuiz(items, retour) {
    const resultats = new Map(); // idRegle -> toutes les réponses justes ?
    let i = 0;
    let bonnes = 0;

    const question = () => {
      if (i >= items.length) return bilan();
      const { regle, q } = items[i];
      const ordre = melanger(q.choix.keys());
      const zoneRetour = h("div", {});

      const boutons = ordre.map((idx) =>
        h(
          "button",
          { class: "choix", onclick: (ev) => repondre(idx, ev.currentTarget) },
          q.choix[idx]
        )
      );

      const repondre = (idx, btn) => {
        const ok = idx === q.reponse;
        boutons.forEach((b, k) => {
          b.disabled = true;
          if (ordre[k] === q.reponse) b.classList.add("bon");
        });
        if (!ok) btn.classList.add("mauvais");
        if (ok) bonnes += 1;
        resultats.set(regle.id, (resultats.get(regle.id) ?? true) && ok);
        zoneRetour.replaceChildren(
          h("p", { class: ok ? "juste" : "faux" }, ok ? "Bravo !" : "Pas tout à fait."),
          h("p", {}, q.explication),
          h(
            "button",
            {
              class: "principal",
              onclick: () => {
                i += 1;
                question();
              }
            },
            i + 1 < items.length ? "Suivant" : "Voir le bilan"
          )
        );
      };

      afficher([
        h("p", { class: "note" }, `Question ${i + 1} / ${items.length} · ${regle.categorie}`),
        h("h2", {}, q.q),
        boutons,
        zoneRetour
      ]);
    };

    const bilan = async () => {
      for (const [id, ok] of resultats) majLeitner(id, ok);
      await sauvegarder();
      const aRelire = [...resultats].filter(([, ok]) => !ok).map(([id]) => id);
      afficher([
        h("h2", {}, "Bilan"),
        h("p", {}, `${bonnes} / ${items.length} bonnes réponses.`),
        aRelire.length
          ? h(
              "div",
              {},
              h("p", { class: "note" }, "À relire :"),
              h("div", { class: "liste" }, aRelire.map(ligneRelire))
            )
          : h("p", { class: "juste" }, "Tout est bon, bien joué ! 🎉"),
        h("div", { class: "actions" }, h("button", { class: "principal", onclick: retour }, "Terminer"))
      ]);
    };

    question();
  }

  function vueRevision() {
    const dues = melanger([
      ...reglesDues().map((regle) => ({
        regle,
        q: regle.quiz[Math.floor(Math.random() * regle.quiz.length)]
      })),
      ...motsDus().map(itemMot)
    ]).slice(0, 10);
    if (!dues.length) {
      afficher([
        h("h2", {}, "Révision"),
        h("p", {}, "Rien à réviser pour le moment. Reviens après de nouvelles erreurs !"),
        h("button", { onclick: () => vueAccueil() }, "Accueil")
      ]);
      return;
    }
    lancerQuiz(dues, () => vueAccueil());
  }

  function vueCarnet() {
    const etat = (e) =>
      `${e.erreurs} erreur(s) · niveau ${e.boite}/${CONFIG.intervallesJours.length - 1} · ` +
      (e.prochaine <= maintenant() ? "à réviser" : new Date(e.prochaine).toLocaleDateString("fr-FR"));
    const lignes = Object.entries(carnet)
      .filter(([id]) => estMot(id) || regleParId(id))
      .sort((a, b) => b[1].erreurs - a[1].erreurs)
      .map(([id, e]) =>
        estMot(id)
          ? h(
              "button",
              { class: "ligne", onclick: () => lancerQuiz([itemMot(id.slice(4))], vueCarnet) },
              `✏️ ${id.slice(4)}`,
              h("small", {}, etat(e))
            )
          : h(
              "button",
              { class: "ligne", onclick: () => vueRegle(regleParId(id)) },
              regleParId(id).titre,
              h("small", {}, etat(e))
            )
      );
    afficher([
      h("h2", {}, "Mon carnet d'erreurs"),
      lignes.length ? h("div", { class: "liste" }, lignes) : h("p", { class: "note" }, "Carnet vide pour l'instant."),
      h(
        "div",
        { class: "actions" },
        h("button", { onclick: () => vueAccueil() }, "Accueil"),
        lignes.length
          ? h(
              "button",
              {
                onclick: async () => {
                  if (window.confirm("Effacer tout le carnet ?")) {
                    carnet = {};
                    await sauvegarder();
                    vueCarnet();
                  }
                }
              },
              "Effacer"
            )
          : null
      )
    ]);
  }

  /* ------------------------ Détection d'une erreur -------------------- */
  const texteVisible = (el) =>
    (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();

  const ressembleAUneErreur = (texte) =>
    texte.length > 0 &&
    texte.length <= CONFIG.tailleMaxTexte &&
    CONFIG.indicesErreur.some((re) => re.test(texte));

  /**
   * Voltaire est une appli React Native Web : pas de classes stables.
   * On part de l'élément qui affiche l'erreur et on remonte dans le DOM
   * jusqu'à obtenir un bloc assez riche (phrase + correction).
   */
  function lireContexte(el) {
    let courant = el;
    let texte = texteVisible(courant);
    while (
      texte.length < CONFIG.tailleContexteMin &&
      courant.parentElement &&
      courant.parentElement !== document.body
    ) {
      courant = courant.parentElement;
      const t = texteVisible(courant);
      if (t.length > CONFIG.tailleContexteMax) break;
      texte = t;
    }
    return texte;
  }

  /** Appelé quand le site affiche un retour qui ressemble à une erreur. */
  async function surRetourErreur(el) {
    if (!el?.isConnected) return;
    const texteRetour = texteVisible(el);
    const contexte = lireContexte(el);
    dernierContexte = contexte;
    // Signature sans chiffres : un compteur ou un score ne relance pas l'analyse.
    const signature = `${texteRetour}|${contexte.replace(/\d+/g, "").slice(0, 300)}`;
    if (signature === derniereSignature) return;
    derniereSignature = signature;

    try {
      if (!regles.length) await chargerEtat();
      const candidats = Matcher.trouverRegles(contexte, regles, 3);
      const pieges = Matcher.trouverMotsPieges(contexte, mots);
      if (!candidats.length) {
        vueAccueil(
          "",
          pieges.length
            ? "Erreur détectée : peut-être un mot difficile (voir ci-dessous)."
            : "Erreur détectée, mais la règle n'est pas identifiée. Cherche-la ci-dessous, ou copie le texte analysé pour que je règle les mots-clés.",
          contexte,
          pieges
        );
        return;
      }
      const [premier, ...autres] = candidats;
      await enregistrerErreur(premier.regle.id);
      vueRegle(premier.regle, autres.map((c) => c.regle), pieges);
    } catch (e) {
      // Ne jamais gêner la page : on journalise et on continue.
      console.error("[Voltaire Coach] Échec de l'analyse :", e);
    }
  }

  /* MutationObserver + sondage de secours -------------------------------- */
  const enAttente = new Set();
  let minuteur = null;

  const observateur = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "characterData") {
        if (m.target.parentElement) enAttente.add(m.target.parentElement);
      } else {
        m.addedNodes.forEach((n) => n.nodeType === Node.ELEMENT_NODE && enAttente.add(n));
      }
    }
    clearTimeout(minuteur);
    minuteur = setTimeout(traiterAjouts, CONFIG.delaiAntiRebond);
  });

  function traiterAjouts() {
    const noeuds = [...enAttente];
    enAttente.clear();
    for (const n of noeuds) {
      if (!n.isConnected || n === hote) continue;
      if (ressembleAUneErreur((n.textContent ?? "").trim())) {
        surRetourErreur(n);
        return;
      }
    }
  }

  /**
   * Filet de sécurité : parcourt les nœuds de texte de la page.
   * Au premier passage (construireBase), on mémorise les textes déjà présents
   * (menus, libellés…) pour ne pas les prendre pour une erreur.
   */
  const textesIgnores = new Set();
  function sonder(construireBase = false) {
    if (!document.body) return;
    const marcheur = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = marcheur.nextNode(); n; n = marcheur.nextNode()) {
      const t = n.nodeValue?.trim();
      if (!t || t.length > 300 || !CONFIG.indicesErreur.some((re) => re.test(t))) continue;
      if (construireBase) textesIgnores.add(t);
      else if (!textesIgnores.has(t)) {
        surRetourErreur(n.parentElement);
        return;
      }
    }
  }

  /* ----------------------------- Démarrage --------------------------- */
  async function demarrer() {
    await chargerEtat();
    document.documentElement.append(hote);
    observateur.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    setTimeout(() => {
      sonder(true);
      setInterval(() => sonder(false), CONFIG.periodeSondage);
    }, 3000);

    document.addEventListener("keydown", (e) => {
      if (e.altKey && e.code === "KeyE") {
        e.preventDefault();
        const selection = String(globalThis.getSelection?.() ?? "").trim();
        vueAccueil(selection.slice(0, 100));
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", demarrer, { once: true });
  } else {
    demarrer();
  }
})();
