# Extension d'Aide au Projet Voltaire
# Voltaire Coach

Extension Firefox (Manifest V3) qui t'aide à progresser sur Projet Voltaire :
quand le site t'indique une erreur, elle t'explique la règle, puis te pose
des questions pour vérifier que tu as compris. Elle **ne répond jamais à ta
place** et ne clique sur rien dans la page.

## Arborescence

```
voltaire-coach/
├── manifest.json     # déclaration MV3 (permission : storage seulement)
├── background.js     # fournit les données ; appelle OpenRouter sur demande
├── options.html/.js  # réglages de l'IA (clé, modèle, autorisations)
├── matcher.js        # retrouve la règle à partir d'un texte (mots-clés)
├── content.js        # détection d'erreur, panneau, quiz, carnet, révision
├── data/regles.json  # 38 règles : explication, exemples, 1 à 3 questions
├── data/mots.json    # mots pièges d'orthographe, avec astuce
└── README.md
```

## Installation (temporaire)

1. Ouvrez `about:debugging#/runtime/this-firefox`.
2. Cliquez sur **Charger un module complémentaire temporaire…**
3. Sélectionnez le fichier `manifest.json` du dossier.
4. Ouvrez `about:addons` → Voltaire Coach → onglet **Autorisations** et active
   l'accès à `projet-voltaire.fr` (en Manifest V3, Firefox demande l'accord
   de l'utilisateur pour les permissions d'hôte).
5. Recharge la page Projet Voltaire : un bouton 📘 apparaît en bas à droite.

L'extension temporaire disparaît au redémarrage de Firefox.

## Utilisation

- **Erreur détectée** : le panneau s'ouvre sur la règle, avec exemples et
  astuce, puis **Me tester** lance le quiz.
- **Alt+E** (ou le bouton 📘) : recherche manuelle. Si tu as sélectionné un
  passage de la page, il sert de requête.
- **Mon carnet** : règles ratées, avec le nombre d'erreurs et la prochaine révision.
- **Réviser** : questions sur les règles dues (répétition espacée : 10 min,
  1, 3, 7, 21, 60 jours selon tes réussites).

## Comment la règle est identifiée

Projet Voltaire est une appli générée en JavaScript (React Native Web) : ses
classes CSS ne sont ni lisibles ni stables. L'extension ne s'appuie donc que
sur le **texte visible** : elle repère le message d'erreur, remonte dans la
page pour récupérer la phrase et la correction autour, puis compare ce texte
aux `mots_cles` et `formes` de chaque règle.

Si aucune règle n'est trouvée, le panneau affiche le **texte analysé** (bouton
Copier). Compare-le avec les `mots_cles` de `data/regles.json` et ajoute-y
les expressions que Voltaire emploie réellement dans ses corrections.

## Orthographe

- **Règles d'orthographe** (doublement des consonnes, -tion/-sion, circonflexe,
  pluriels en -x / -aux, h aspiré, peut-être…) : expliquées et testées comme
  les autres règles.
- **Mots pièges** (`data/mots.json`, ~60 mots) : si un de ces mots figure dans
  la phrase de l'exercice, écrit correctement ou avec une faute d'une lettre,
  le panneau l'affiche avec son astuce. **Retenir** l'ajoute à ton carnet,
  **Me tester** te propose la bonne orthographe parmi de fausses variantes
  générées automatiquement.
- **Noter un mot** : le champ « Mot à retenir » (accueil et règles
  d'orthographe) ajoute n'importe quel mot au carnet. Les mots du carnet sont
  repris dans « Réviser » avec la même répétition espacée.

## Aide de l'IA (OpenRouter, optionnelle)

Quand la règle n'est pas trouvée, ou si elle te semble fausse, le bouton
**🤖 Demander à l'IA** envoie le texte analysé à OpenRouter. Le modèle propose
une règle, une explication et une question de contrôle. Une règle nouvelle est
enregistrée dans ton carnet et peut être révisée comme les autres (elle est
marquée « proposée par l'IA : à vérifier »).

1. Crée une clé sur `openrouter.ai/keys` (fixe-lui une limite de dépense).
2. Clique sur ⚙️ dans le panneau, ou ouvre `about:addons` → Voltaire Coach →
   Préférences.
3. Coche « Activer », colle la clé, choisis le modèle, puis **Enregistrer**.
   Firefox demande l'autorisation d'envoyer le contenu de la page à OpenRouter.
4. **Tester la connexion** vérifie la clé.
> [!WARNING]
> **ATTENTION :** Si le programme affiche une erreur alors que vous avez enregistré les modifications, regardez uniquement le début de l'erreur. L'erreur dira toujours que vous n'avez pas enregistré.

Rien n'est envoyé sans clic. Seul le texte de la zone d'exercice est transmis
(pas l'adresse de la page, pas de compte). La clé reste dans le background :
le script injecté dans la page n'y a jamais accès.

## Données et confidentialité

- Par défaut : aucune requête réseau. Seule l'aide de l'IA, désactivée par défaut et déclenchée par un clic, contacte `openrouter.ai`.
- Le carnet est stocké uniquement dans `storage.local` de ton navigateur.
- Le seul accès demandé est le domaine `projet-voltaire.fr`.

## Ajouter des règles

Pour ajouter des règles d'orthographe ou de grammaire dans `data/regles.json` collez ce code et changez-le à votre façon :

```json
{
  "id": "identifiant-unique",
  "titre": "Titre affiché",
  "categorie": "Homophones",
  "mots_cles": ["expressions qui apparaissent dans les corrections du site"],
  "formes": ["mots distinctifs de la phrase, ex. quelle"],
  "explication": "…",
  "astuce": "…",
  "exemples": [{ "faux": "…", "juste": "…" }],
  "quiz": [
    { "q": "…", "choix": ["a", "b"], "reponse": 0, "explication": "…" }
  ]
}
```

`reponse` est l'indice (à partir de 0) de la bonne réponse dans `choix`.
Plus tes `mots_cles` reprennent le vocabulaire des corrections de Voltaire,
mieux la règle sera identifiée.
