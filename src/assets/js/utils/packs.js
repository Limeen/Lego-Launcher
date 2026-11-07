/**
 * Packs de textures et packs de shaders d'une instance : lecture (pack.mcmeta, pack.png),
 * compatibilité avec la version du jeu, activation et import.
 *
 * - Packs de textures : `resourcepacks/`. L'activation est celle du jeu (liste `resourcePacks`
 *   de options.txt), le launcher et le menu du jeu restent donc synchronisés.
 * - Shaders : `shaderpacks/`, chargés par Iris, Oculus ou OptiFine. Le pack actif est celui de
 *   `config/iris.properties`, `config/oculus.properties` ou `optionsshaders.txt`.
 *
 * Un pack peut être une archive .zip ou un dossier.
 */

import { readZipEntries, parseJson, parseVersion, compare } from './mods.js';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/* Format de pack du jeu                                               */
/* ------------------------------------------------------------------ */

/**
 * Format des packs de textures par version, utilisé quand le jeu n'est pas encore installé
 * (sinon le format est lu dans le jar du jeu). [version minimale, format].
 */
const RESOURCE_FORMATS = [
    ['1.6.1', 1], ['1.9', 2], ['1.11', 3], ['1.13', 4], ['1.15', 5], ['1.16.2', 6],
    ['1.17', 7], ['1.18', 8], ['1.19', 9], ['1.19.3', 12], ['1.19.4', 13], ['1.20', 15],
    ['1.20.2', 18], ['1.20.3', 22], ['1.20.5', 32], ['1.21', 34], ['1.21.2', 42],
    ['1.21.4', 46], ['1.21.5', 55], ['1.21.6', 63], ['1.21.7', 64], ['1.21.9', 69]
];
/** Dernière version couverte par la table : au-delà, il faut lire le jar. */
const TABLE_LIMIT = [1, 21, 10];

let formatCache = new Map();

/**
 * Format des packs de textures accepté par une version de Minecraft, sous la forme [majeur, mineur].
 * Lu dans `version.json` du jar du jeu s'il est installé, sinon déduit d'une table.
 * @param {string} gamePath
 * @param {string} mcVersion
 * @returns {number[]|null} null si inconnu (version récente pas encore installée, snapshot...)
 */
export function gameResourceFormat(gamePath, mcVersion) {
    if (!mcVersion) return null;
    let jar = `${gamePath}/versions/${mcVersion}/${mcVersion}.jar`;
    let key = jar;
    try { key += `|${fs.statSync(jar).mtimeMs}`; } catch { }
    if (formatCache.has(key)) return formatCache.get(key);

    let format = null;
    try {
        let entry = readZipEntries(jar, n => n === 'version.json').get('version.json');
        let pv = entry && parseJson(entry).pack_version;
        if (typeof pv === 'number') format = [pv, 0];
        else if (pv?.resource_major !== undefined) format = [pv.resource_major, pv.resource_minor || 0];
        else if (pv?.resource !== undefined) format = [pv.resource, 0];
    } catch { /* jeu pas encore installé */ }

    if (!format) {
        let v = parseVersion(mcVersion);
        if (v && compare(v, TABLE_LIMIT) <= 0) {
            let row = RESOURCE_FORMATS.filter(([min]) => compare(v, parseVersion(min)) >= 0).pop();
            if (row) format = [row[1], 0];
        }
    }
    formatCache.set(key, format);
    return format;
}

/** Format de pack « 34 », [69, 0] ou { major, minor } → [majeur, mineur]. */
function toFormat(value) {
    if (typeof value === 'number') return [value, 0];
    if (Array.isArray(value) && typeof value[0] === 'number') return [value[0], value[1] || 0];
    return null;
}

/**
 * Intervalle de formats déclaré par un pack : `min_format`/`max_format` (1.21.9+),
 * `supported_formats` (1.20.2+) ou simplement `pack_format`.
 * @returns {{min: number[], max: number[]}|null}
 */
function packRange(pack) {
    if (!pack) return null;
    let min = toFormat(pack.min_format);
    let max = toFormat(pack.max_format);
    if (min || max) {
        // Un format majeur seul (« 69 ») couvre toutes ses versions mineures.
        let maxValue = typeof pack.max_format === 'number' ? [pack.max_format, Infinity] : max;
        return { min: min || [0, 0], max: maxValue || [Infinity, 0] };
    }
    let sf = pack.supported_formats;
    let format = typeof pack.pack_format === 'number' ? pack.pack_format : null;
    let low = format, high = format;
    if (typeof sf === 'number') { low = Math.min(low ?? sf, sf); high = Math.max(high ?? sf, sf); }
    else if (Array.isArray(sf) && sf.length === 2) { low = Math.min(low ?? sf[0], sf[0]); high = Math.max(high ?? sf[1], sf[1]); }
    else if (sf && typeof sf === 'object') {
        if (typeof sf.min_inclusive === 'number') low = Math.min(low ?? sf.min_inclusive, sf.min_inclusive);
        if (typeof sf.max_inclusive === 'number') high = Math.max(high ?? sf.max_inclusive, sf.max_inclusive);
    }
    if (low === null || high === null) return null;
    return { min: [low, 0], max: [high, Infinity] };
}

/**
 * Compatibilité d'un pack de textures avec le format du jeu.
 * @param {object} info Résultat de readPackInfo
 * @param {number[]|null} gameFormat
 * @returns {"ok"|"old"|"new"|"invalid"|"unknown"}
 *  old/new : prévu pour une version plus ancienne / plus récente (le jeu l'affiche « incompatible »
 *  mais peut quand même le charger) ; invalid : pas un pack ; unknown : impossible à vérifier.
 */
export function packCompatibility(info, gameFormat) {
    if (!info || info.invalid) return 'invalid';
    if (!info.range || !gameFormat) return 'unknown';
    if (compare(gameFormat, info.range.min) < 0) return 'new';
    if (info.range.max[0] !== Infinity && compare(gameFormat, info.range.max.map(n => n === Infinity ? 1e9 : n)) > 0) return 'old';
    return 'ok';
}

/* ------------------------------------------------------------------ */
/* Lecture des packs                                                   */
/* ------------------------------------------------------------------ */

/** Texte brut d'une description de pack (chaîne, composant JSON ou liste), sans codes §. */
function flattenText(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(flattenText).join('');
    if (typeof value === 'object') return flattenText(value.text ?? value.translate ?? '') + flattenText(value.extra);
    return '';
}

function cleanText(text) {
    return text.replace(/§./g, '').replace(/\s+/g, ' ').trim();
}

/** pack.png en data URL (ignorée au-delà de 300 Ko). */
function iconUrl(buffer) {
    if (!buffer || buffer.length > 300000) return null;
    return `data:image/png;base64,${buffer.toString('base64')}`;
}

/**
 * Fichiers à la racine d'un pack (archive ou dossier) : renvoie les buffers demandés et
 * indique si un dossier `prefix` existe à la racine ou un niveau plus bas.
 */
function readPackFiles(file, names, prefix) {
    let isDir = fs.statSync(file).isDirectory();
    let files = new Map();
    let hasRoot = false, nestedIn = null;

    if (isDir) {
        for (let n of names) {
            try { files.set(n, fs.readFileSync(path.join(file, n))); } catch { }
        }
        if (prefix) {
            hasRoot = fs.existsSync(path.join(file, prefix));
            if (!hasRoot) {
                for (let sub of fs.readdirSync(file)) {
                    if (fs.existsSync(path.join(file, sub, prefix))) { nestedIn = sub; break; }
                }
            }
        }
        return { files, hasRoot, nestedIn, isDir };
    }

    let wanted = new Set(names);
    let entries = readZipEntries(file, n => {
        if (prefix) {
            if (n.startsWith(`${prefix}/`)) hasRoot = true;
            else if (!nestedIn) {
                let m = n.match(new RegExp(`^([^/]+)/${prefix}/`));
                if (m) nestedIn = m[1];
            }
        }
        // Pack zippé dans un sous-dossier : on lit quand même ses métadonnées pour le signaler.
        return wanted.has(n) || wanted.has(n.replace(/^[^/]+\//, ''));
    });
    for (let [n, data] of entries) {
        if (wanted.has(n)) files.set(n, data);
        else if (!files.has(n.replace(/^[^/]+\//, ''))) {
            let inner = n.replace(/^[^/]+\//, '');
            files.set(`nested:${inner}`, data);
            if (inner === 'pack.mcmeta') nestedIn = n.split('/')[0];
        }
    }
    return { files, hasRoot, nestedIn, isDir };
}

let infoCache = new Map();

/** Clé de cache : chemin + taille + date de modification. */
function cacheKey(file) {
    let stat = fs.statSync(file);
    return `${file}|${stat.size}|${stat.mtimeMs}`;
}

/**
 * Métadonnées d'un pack de textures. Ne lève jamais.
 * @param {string} file Archive .zip ou dossier
 * @returns {{name: string, description: string, icon: string|null, range: object|null, invalid?: boolean, nestedIn?: string, error?: string}}
 */
export function readResourcePack(file) {
    let key;
    try { key = 'resource|' + cacheKey(file); } catch { return null; }
    if (infoCache.has(key)) return infoCache.get(key);

    let info = { name: path.basename(file).replace(/\.zip$/i, ''), description: '', icon: null, range: null };
    try {
        let { files, nestedIn } = readPackFiles(file, ['pack.mcmeta', 'pack.png']);
        let mcmeta = files.get('pack.mcmeta');
        if (!mcmeta) {
            info.invalid = true;
            if (files.has('nested:pack.mcmeta')) info.nestedIn = nestedIn;
        } else {
            let pack = parseJson(mcmeta).pack || {};
            info.description = cleanText(flattenText(pack.description));
            info.range = packRange(pack);
            info.icon = iconUrl(files.get('pack.png'));
        }
    } catch (err) {
        info.invalid = true;
        info.error = err.message;
    }
    infoCache.set(key, info);
    return info;
}

/**
 * Métadonnées d'un pack de shaders. Ne lève jamais.
 * Un pack valide contient un dossier `shaders/` à sa racine. Les packs de shaders ne déclarent
 * pas de version de Minecraft : seule la présence d'un mod de shaders peut être vérifiée.
 * @param {string} file Archive .zip ou dossier
 */
export function readShaderPack(file) {
    let key;
    try { key = 'shader|' + cacheKey(file); } catch { return null; }
    if (infoCache.has(key)) return infoCache.get(key);

    let info = { name: path.basename(file).replace(/\.zip$/i, ''), description: '', icon: null };
    try {
        let { hasRoot, nestedIn } = readPackFiles(file, [], 'shaders');
        if (!hasRoot) {
            info.invalid = true;
            info.nestedIn = nestedIn;
        }
    } catch (err) {
        info.invalid = true;
        info.error = err.message;
    }
    infoCache.set(key, info);
    return info;
}

/* ------------------------------------------------------------------ */
/* Dossiers                                                            */
/* ------------------------------------------------------------------ */

export const PACK_FOLDERS = { resourcepacks: 'resourcepacks', shaderpacks: 'shaderpacks' };

/**
 * Liste les packs d'un dossier (archives .zip et dossiers), triés par nom.
 * @param {string} instanceDir
 * @param {"resourcepacks"|"shaderpacks"} kind
 */
export function listPacks(instanceDir, kind) {
    let dir = `${instanceDir}/${PACK_FOLDERS[kind]}`;
    if (!fs.existsSync(dir)) return [];
    let read = kind === 'shaderpacks' ? readShaderPack : readResourcePack;
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => (e.isFile() && /\.zip$/i.test(e.name)) || e.isDirectory())
        .map(e => ({ file: e.name, path: `${dir}/${e.name}`, folder: e.isDirectory(), info: read(`${dir}/${e.name}`) }))
        .filter(p => !p.folder || !p.info?.invalid || p.info?.nestedIn) // dossiers sans rapport ignorés
        .sort((a, b) => a.file.localeCompare(b.file, 'fr', { sensitivity: 'base' }));
}

/**
 * Copie un pack (archive ou dossier) dans l'instance.
 * @returns {string} Nom du pack copié
 */
export function importPack(instanceDir, kind, source) {
    let dir = `${instanceDir}/${PACK_FOLDERS[kind]}`;
    fs.mkdirSync(dir, { recursive: true });
    let target = `${dir}/${path.basename(source)}`;
    fs.cpSync(source, target, { recursive: true, force: true });
    return path.basename(target);
}

/** Supprime un pack (archive ou dossier). */
export function deletePack(instanceDir, kind, file) {
    fs.rmSync(`${instanceDir}/${PACK_FOLDERS[kind]}/${file}`, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* Activation des packs de textures (options.txt)                      */
/* ------------------------------------------------------------------ */

/** Identifiant d'un pack dans options.txt (« file/Pack.zip », sans préfixe avant 1.13). */
function packId(file, mcVersion) {
    let v = parseVersion(mcVersion);
    return v && compare(v, [1, 13]) < 0 ? file : `file/${file}`;
}

/** Lit options.txt sous forme de lignes. */
function readOptions(instanceDir) {
    try { return fs.readFileSync(`${instanceDir}/options.txt`, 'utf8').split(/\r?\n/); } catch { return null; }
}

/** Valeur JSON d'une liste d'options.txt (resourcePacks, incompatibleResourcePacks). */
function optionList(lines, key) {
    let line = lines?.find(l => l.startsWith(`${key}:`));
    if (!line) return [];
    try {
        let value = JSON.parse(line.slice(key.length + 1));
        return Array.isArray(value) ? value.map(String) : [];
    } catch { return []; }
}

/**
 * Packs de textures actifs dans le jeu, du moins au plus prioritaire.
 * @returns {string[]} Noms de fichiers
 */
export function activeResourcePacks(instanceDir, mcVersion) {
    let ids = optionList(readOptions(instanceDir), 'resourcePacks');
    let prefix = packId('', mcVersion);
    return ids.filter(id => id.startsWith(prefix) && id !== 'vanilla').map(id => id.slice(prefix.length));
}

/**
 * Active ou désactive un pack de textures dans options.txt. Un pack activé passe en tête de
 * priorité ; un pack incompatible est aussi ajouté à `incompatibleResourcePacks`, sans quoi le jeu
 * le retirerait au démarrage.
 */
export function setResourcePackEnabled(instanceDir, mcVersion, file, enabled, incompatible) {
    let lines = readOptions(instanceDir) || [];
    let id = packId(file, mcVersion);
    let packs = optionList(lines, 'resourcePacks').filter(p => p !== id);
    let incompat = optionList(lines, 'incompatibleResourcePacks').filter(p => p !== id);
    if (enabled) {
        packs.push(id);
        if (incompatible) incompat.push(id);
    }
    let set = (key, value) => {
        let text = `${key}:${JSON.stringify(value)}`;
        let i = lines.findIndex(l => l.startsWith(`${key}:`));
        if (i >= 0) lines[i] = text;
        else {
            let end = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
            lines.splice(end, 0, text);
        }
    };
    set('resourcePacks', packs);
    set('incompatibleResourcePacks', incompat);
    if (lines[lines.length - 1] !== '') lines.push('');
    fs.writeFileSync(`${instanceDir}/options.txt`, lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* Shaders                                                             */
/* ------------------------------------------------------------------ */

/**
 * Mod de shaders installé et actif dans l'instance.
 * @param {Array} mods Résultat de listMods
 * @returns {{id: "iris"|"oculus"|"optifine", name: string}|null}
 */
export function shaderLoader(mods) {
    let active = mods.filter(m => m.enabled);
    if (active.some(m => m.info?.id === 'iris')) return { id: 'iris', name: 'Iris' };
    if (active.some(m => m.info?.id === 'oculus')) return { id: 'oculus', name: 'Oculus' };
    if (active.some(m => /optifine/i.test(m.file) || m.info?.id === 'optifine')) return { id: 'optifine', name: 'OptiFine' };
    return null;
}

/** Fichier de configuration du mod de shaders. */
function shaderConfigFile(instanceDir, loader) {
    if (loader.id === 'optifine') return `${instanceDir}/optionsshaders.txt`;
    return `${instanceDir}/config/${loader.id}.properties`;
}

/** Lit un fichier clé=valeur (.properties / optionsshaders.txt). */
function readProperties(file) {
    try { return fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return []; }
}

/** Décode une valeur .properties (Iris écrit les « : » et « = » échappés). */
function unescapeProp(value) {
    return value
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\(.)/g, '$1');
}

/** Encode une valeur pour un .properties Java (lu en ISO-8859-1 : caractères accentués en \uXXXX). */
function escapeProp(value) {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/^ /, '\\ ')
        .replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Pack de shaders actif, ou null si les shaders sont désactivés.
 * @returns {string|null} Nom de fichier du pack
 */
export function activeShaderPack(instanceDir, loader) {
    if (!loader) return null;
    let props = {};
    for (let line of readProperties(shaderConfigFile(instanceDir, loader))) {
        let m = line.match(/^\s*([^#=:\s]+)\s*[=:]\s*(.*)$/);
        if (m) props[m[1]] = unescapeProp(m[2].trim());
    }
    let pack = props.shaderPack;
    if (!pack || pack === 'OFF' || pack === '(internal)') return null;
    if (loader.id !== 'optifine' && props.enableShaders === 'false') return null;
    return pack;
}

/**
 * Choisit le pack de shaders utilisé par le jeu (null pour désactiver les shaders).
 * @param {string} instanceDir
 * @param {{id: string}} loader
 * @param {string|null} file
 */
export function setActiveShaderPack(instanceDir, loader, file) {
    let target = shaderConfigFile(instanceDir, loader);
    let lines = readProperties(target);
    let set = (key, value) => {
        let i = lines.findIndex(l => new RegExp(`^\\s*${key}\\s*[=:]`).test(l));
        if (i >= 0) lines[i] = `${key}=${value}`;
        else lines.splice(lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
    };
    if (loader.id === 'optifine') {
        set('shaderPack', file || 'OFF');
    } else {
        if (file) set('shaderPack', escapeProp(file));
        set('enableShaders', file ? 'true' : 'false');
    }
    if (lines[lines.length - 1] !== '') lines.push('');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, lines.join('\n'));
}

/**
 * Libellé lisible d'un format de pack, pour les messages.
 * @param {{min: number[], max: number[]}} range
 */
export function formatRangeLabel(range) {
    if (!range) return '?';
    let low = versionsForFormat(range.min[0]);
    let high = range.max[0] === Infinity ? null : versionsForFormat(range.max[0]);
    if (low && range.max[0] === Infinity) return `Minecraft ${low.first} ou plus récent`;
    if (low && high) return low.first === high.last ? `Minecraft ${low.first}` : `Minecraft ${low.first} à ${high.last}`;
    let f = v => (v[1] && v[1] !== Infinity ? `${v[0]}.${v[1]}` : `${v[0]}`);
    return range.min[0] === range.max[0] || range.max[0] === Infinity ? `le format de pack ${f(range.min)}` : `le format de pack ${f(range.min)} à ${f(range.max)}`;
}

/** Versions de Minecraft (première et dernière connues) utilisant un format de pack donné. */
function versionsForFormat(format) {
    let i = RESOURCE_FORMATS.findIndex(([, f]) => f === format);
    if (i < 0) return null;
    let next = RESOURCE_FORMATS[i + 1];
    let last = RESOURCE_FORMATS[i][0];
    if (next) {
        // Dernière version avant le format suivant : 1.20.5 → 1.20.6, 1.21 → 1.21.1...
        let v = parseVersion(next[0]);
        let lastKnown = { '1.9': '1.8.9', '1.11': '1.10.2', '1.13': '1.12.2', '1.15': '1.14.4', '1.16.2': '1.16.1', '1.17': '1.16.5', '1.18': '1.17.1', '1.19': '1.18.2', '1.19.3': '1.19.2', '1.19.4': '1.19.3', '1.20': '1.19.4', '1.20.2': '1.20.1', '1.20.3': '1.20.2', '1.20.5': '1.20.4', '1.21': '1.20.6', '1.21.2': '1.21.1', '1.21.4': '1.21.3', '1.21.5': '1.21.4', '1.21.6': '1.21.5', '1.21.7': '1.21.6', '1.21.9': '1.21.8' };
        last = lastKnown[next[0]] || (v ? next[0] : last);
    } else {
        last = '1.21.10';
    }
    return { first: RESOURCE_FORMATS[i][0], last };
}
