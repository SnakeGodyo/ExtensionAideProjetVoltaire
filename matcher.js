/**
 * matcher.js : retrouve les règles de grammaire correspondant à un texte.
 * Le texte peut être l'explication affichée par le site après une erreur,
 * la phrase de l'exercice, ou une recherche tapée à la main.
 * Exposé globalement via globalThis.VoltaireMatcher (chargé avant content.js).
 */
(() => {
  "use strict";

  /** Minuscules, sans accents, apostrophes typographiques normalisées. */
  function normaliser(texte) {
    return String(texte ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[’‘]/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Renvoie les règles les plus pertinentes : [{ regle, score }], triées.
   * - Mot-clé exact trouvé dans le texte : score proportionnel à sa longueur
   *   (un mot-clé long est plus spécifique).
   * - Pour une recherche courte (saisie manuelle), on accepte aussi les
   *   fragments de mots présents dans le titre ou les mots-clés.
   */
  function trouverRegles(texte, regles, max = 3) {
    const n = normaliser(texte);
    if (!n) return [];
    const rechercheCourte = n.length <= 60;
    const jetons = rechercheCourte
      ? n.split(/[^a-z0-9']+/).filter((j) => j.length >= 4)
      : [];

    const resultats = [];
    for (const regle of regles) {
      let score = 0;
      const motsCles = (regle.mots_cles ?? []).map(normaliser);

      for (const mc of motsCles) {
        if (mc && n.includes(mc)) score += mc.length * 2;
      }

      // Formes distinctives (ex. « quelle », « plutôt ») repérées comme mots entiers.
      for (const f of (regle.formes ?? []).map(normaliser)) {
        if (f && new RegExp(`(^|[^a-z'])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z'])`).test(n)) {
          score += 8;
        }
      }

      if (rechercheCourte) {
        const titre = normaliser(regle.titre);
        if (n.length >= 3 && titre.includes(n)) score += 30;
        const corpus = `${titre} ${motsCles.join(" ")}`;
        for (const j of jetons) {
          if (corpus.includes(j)) score += j.length;
        }
      }

      if (score > 0) resultats.push({ regle, score });
    }
    return resultats.sort((a, b) => b.score - a.score).slice(0, max);
  }

  /* -------------------- Orthographe d'usage (mots pièges) -------------------- */

  /** Vrai si a et b diffèrent d'exactement une lettre (substitution, ajout ou oubli). */
  function aUneLettreDeDifference(a, b) {
    if (a === b || Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
    const [court, long] = a.length < b.length ? [a, b] : [b, a];
    return court.slice(i) === long.slice(i + 1);
  }

  const melanger = (t) => {
    const c = [...t];
    for (let i = c.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [c[i], c[j]] = [c[j], c[i]];
    }
    return c;
  };

  /**
   * Fabrique de fausses orthographes plausibles pour un mot (doublement ou
   * dédoublement de consonne, accents, ph/f, tion/sion, y/i…).
   * Sert de distracteurs dans les quiz.
   */
  function genererVariantes(mot, max = 3) {
    const lettres = [...mot];
    const consonnes = "bcdfglmnprst";
    const v = new Set();
    const recoller = (i, remplacement, saut = 1) =>
      lettres.slice(0, i).join("") + remplacement + lettres.slice(i + saut).join("");

    lettres.forEach((c, i) => {
      if (i > 0 && consonnes.includes(c) && lettres[i - 1] !== c && lettres[i + 1] !== c) v.add(recoller(i, c + c));
      if (i > 0 && c === lettres[i - 1] && consonnes.includes(c)) v.add(recoller(i, "", 1));
    });
    const accents = { "é": ["è", "e"], "è": ["é", "e"], "ê": ["e", "è"], "â": ["a"], "î": ["i"], "ô": ["o"], "û": ["u"], "ï": ["i"] };
    lettres.forEach((c, i) => (accents[c] ?? []).forEach((x) => v.add(recoller(i, x))));
    lettres.forEach((c, i) => {
      if (c === "e" && i < lettres.length - 1) v.add(recoller(i, "é"));
    });
    for (const [a, b] of [["ph", "f"], ["f", "ph"], ["tion", "sion"], ["sion", "tion"], ["y", "i"], ["i", "y"], ["th", "t"], ["qu", "c"]]) {
      if (mot.includes(a)) v.add(mot.replace(a, b));
    }
    v.delete(mot);
    let liste = melanger([...v].filter((s) => s.length >= 2));
    if (liste.length < 2 && lettres.length > 3) {
      const t = [...lettres];
      [t[1], t[2]] = [t[2], t[1]];
      liste.push(t.join(""));
    }
    return liste.filter((s) => s !== mot).slice(0, max);
  }

  /**
   * Repère dans un texte les mots pièges connus, qu'ils soient écrits
   * correctement ou avec une faute d'une lettre. Les mots exacts passent d'abord.
   */
  function trouverMotsPieges(texte, mots, max = 4) {
    const jetons = [...new Set(String(texte ?? "").toLowerCase().match(/[\p{L}-]+/gu) ?? [])];
    const exacts = [];
    const proches = [];
    for (const entree of mots) {
      if (jetons.includes(entree.mot)) exacts.push(entree);
      else if (entree.mot.length >= 5 && jetons.some((j) => j.length >= 5 && aUneLettreDeDifference(j, entree.mot))) {
        proches.push(entree);
      }
    }
    return [...exacts, ...proches].slice(0, max);
  }

  globalThis.VoltaireMatcher = { normaliser, trouverRegles, genererVariantes, trouverMotsPieges };
})();
