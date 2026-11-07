# Venstone Launcher

Launcher Minecraft du serveur **[Venstone](https://venstone.xyz)**, basé sur Electron et [minecraft-java-core](https://github.com/luuxis/minecraft-java-core).

Il installe et lance les **instances officielles** du serveur (modpacks maintenus par l'équipe), permet aux joueurs de créer leurs **propres instances** (Vanilla, Fabric, Quilt, Forge, NeoForge) et reste **utilisable sans connexion** pour les instances déjà installées.

Téléchargement : [venstone.xyz/launcher](https://venstone.xyz/launcher)

---

## Fonctionnalités

- **Instances officielles** récupérées depuis l'API Venstone, toujours mises en avant dans le sélecteur.
- **Instances personnelles** : choix de la version de Minecraft, du mod loader et de sa version, installation de Fabric API, icône personnalisée (image) ou couleur.
- **Gestion des mods** par instance : activation/désactivation, import (bouton ou glisser-déposer), suppression, et **vérification de compatibilité** (loader, version de Minecraft, dépendances manquantes) avant chaque ajout.
- **Packs de textures** par instance : activation et ordre de priorité par glisser-déposer (synchronisés avec le menu du jeu), import, suppression et vérification du format de pack par rapport à la version du jeu.
- **Recherche sur Modrinth** depuis chaque onglet (mods, packs de textures, shaders), filtrée selon la version et le mod loader de l'instance.
- **Shaders** (instances moddées) : choix du pack actif pour Iris, Oculus ou OptiFine, détection des packs invalides et du mod de shaders manquant.
- **Mode hors-ligne** : si l'API ou internet est indisponible, le launcher démarre avec les dernières données connues et relance le jeu sans rien télécharger.
- **Mondes, serveurs et captures d'écran partagés** entre toutes les instances.
- **Comptes Venstone** hors-ligne (pseudo), avec un UUID stable identique à celui calculé par le serveur.
- **Paramètres** : mémoire, résolution, plein écran, arguments JVM, Java personnalisé, comportement au lancement, accès rapide aux dossiers.
- **Mises à jour automatiques** du launcher via les releases GitHub.

## Démarrage rapide (développement)

Prérequis : [Node.js](https://nodejs.org) 18 ou plus récent.

```bash
npm install
npm run dev     # lance le launcher et le relance à chaque modification (nodemon)
npm start       # lance le launcher une seule fois
```

En développement (`NODE_ENV=dev`), toutes les données sont stockées dans le dossier `data/` du projet au lieu du dossier utilisateur, et la fenêtre de mise à jour est ignorée.

## Build et publication

```bash
npm run build   # obfusque src/ dans app/ puis génère l'installateur dans dist/
```

Un build local produit l'installateur dans `dist/` sans rien publier.

La publication est automatique : un **push sur `master`** déclenche le workflow GitHub Actions (`.github/workflows/build.yml`), qui crée une release nommée d'après la `version` de `package.json` et y envoie les builds Windows, macOS et Linux. Les launchers déjà installés détectent cette release et se mettent à jour. **Pensez à augmenter la version** avant de pousser.

## Structure du projet

```
src/
├── app.js                     Processus principal Electron (fenêtres, IPC, auto-update)
├── index.html                 Fenêtre de mise à jour (splash)
├── launcher.html              Fenêtre principale
├── panels/                    HTML des panneaux : login, home, settings
└── assets/
    ├── css/                   Styles (thème, panneaux, instances, paramètres)
    └── js/
        ├── index.js           Splash : recherche de mise à jour, maintenance, hors-ligne
        ├── launcher.js        Démarrage : config, comptes, création des panneaux
        ├── utils.js           Fonctions communes (panneaux, comptes, statut du serveur)
        ├── panels/
        │   ├── home.js            Accueil, sélecteur/création d'instance, lancement du jeu
        │   ├── instanceEditor.js  Fenêtre d'édition d'une instance (mods, packs, shaders, paramètres)
        │   ├── login.js           Connexion
        │   └── settings.js        Paramètres
        ├── utils/
        │   ├── config.js          Accès à l'API Venstone avec cache hors-ligne
        │   ├── instances.js       Instances locales, chemins, versions disponibles
        │   ├── instanceForm.js    Formulaire d'instance (création et édition)
        │   ├── launch.js          Lancement du jeu avec repli hors-ligne
        │   ├── mods.js            Lecture des .jar et compatibilité des mods
        │   ├── packs.js           Packs de textures et de shaders (format, activation)
        │   ├── shared.js          Mondes / serveurs / captures partagés
        │   ├── database.js        Stockage SQLite (comptes, configuration)
        │   └── dialog.js          Boîte de confirmation
        └── windows/               Création des fenêtres Electron
```

## Fonctionnement

### API Venstone

Le launcher lit sa configuration sur `https://venstone.xyz/launcher-data/stable/` (avec un serveur de secours) :

| Ressource | Rôle |
| --- | --- |
| `launcher/config-launcher/config.json` | Maintenance, type de connexion, dossier du jeu (`dataDirectory`) |
| `files/` | Liste des instances officielles (version, loader, fichiers à synchroniser, whitelist, statut du serveur) |
| `launcher/news-launcher/news.json` | Actualités affichées sur l'accueil |

Chaque réponse est mise en cache dans `<userData>/launcher-api-cache/`. Sans réseau, le cache est utilisé ; au tout premier démarrage sans réseau, une configuration par défaut est appliquée.

### Lancement hors-ligne

Après chaque lancement réussi, le launcher enregistre ce dont le jeu a besoin pour démarrer (JSON de version, JSON du loader, chemin de Java) dans `.venstone/launcher-cache/<instance>.json`. Sans connexion, la phase de téléchargement est sautée et le jeu démarre à partir de ce cache. Une instance jamais lancée ne peut donc pas être jouée hors-ligne.

### Données partagées

Avant chaque lancement, les dossiers `saves/` et `screenshots/` de l'instance sont remplacés par des liens (jonctions sous Windows) vers `.venstone/shared/`, et `servers.dat` est synchronisé. À la première migration, le contenu existant est déplacé (jamais copié puis supprimé) ; un monde verrouillé reste en place et est déplacé au lancement suivant.

### Instances personnelles et mods

Les instances créées par le joueur sont décrites dans `<userData>/local-instances.json` (une icône personnalisée y est stockée en PNG 128 px, encodé en base64). Une instance Vanilla n'affiche que les packs de textures et ses paramètres. Les mods se trouvent dans `.venstone/instances/<nom>/mods/` ; un mod désactivé est renommé en `.jar.disabled`. La compatibilité est déterminée à partir de `fabric.mod.json`, `quilt.mod.json`, `META-INF/mods.toml` ou `META-INF/neoforge.mods.toml`.

### Packs de textures et shaders

Les packs (archives `.zip` ou dossiers) se trouvent dans `resourcepacks/` et `shaderpacks/` de l'instance.

- **Textures** : le format accepté par le jeu est lu dans `version.json` du jar de Minecraft (ou déduit d'une table si le jeu n'est pas encore installé) et comparé à `pack_format`, `supported_formats` ou `min_format`/`max_format` du `pack.mcmeta`. Les packs actifs sont écrits dans la liste `resourcePacks` de `options.txt`, dans l'ordre choisi (un pack activé passe en tête) (et à `incompatibleResourcePacks` s'il est prévu pour une autre version, sinon le jeu le retirerait).
- **Shaders** : un pack valide contient un dossier `shaders/` à sa racine. Les packs de shaders ne déclarent pas de version de Minecraft ; le launcher vérifie qu'un mod de shaders est actif et écrit le pack choisi dans `config/iris.properties`, `config/oculus.properties` ou `optionsshaders.txt`.

## Emplacement des données (Windows)

| Données | Emplacement |
| --- | --- |
| Jeu, instances, Java, mondes partagés | `%APPDATA%\.venstone\` |
| Comptes et configuration (SQLite) | `%APPDATA%\venstone-launcher\databases\` |
| Instances personnelles, cache de l'API | `%APPDATA%\venstone-launcher\` |

Sous macOS, le dossier du jeu est `~/Library/Application Support/venstone`.

## Licence

Basé sur le launcher open source de [Luuxis](https://github.com/luuxis), distribué sous la **Luuxis License v1.0** (voir [LICENSE.md](LICENSE.md)). Développé pour Venstone par Limeen.
