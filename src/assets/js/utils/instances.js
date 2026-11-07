/**
 * Gestion des instances : officielles (API Venstone) + locales (créées par le joueur).
 * Les instances locales sont stockées dans `<userData>/local-instances.json`.
 */

const fs = require('fs');
const path = require('path');
const nodeFetch = require('node-fetch');
const { ipcRenderer } = require('electron');

import config from './config.js';
import { unlinkSharedData } from './shared.js';

const TIMEOUT = 8000;
const FORBIDDEN_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

export const LOADERS = {
    none: { label: 'Vanilla', short: 'Vanilla' },
    fabric: { label: 'Fabric', short: 'Fabric' },
    quilt: { label: 'Quilt', short: 'Quilt' },
    forge: { label: 'Forge', short: 'Forge' },
    neoforge: { label: 'NeoForge', short: 'NeoForge' }
};

export const INSTANCE_COLORS = ['#2379ee', '#1ac707', '#f8bd19', '#e5484d', '#a855f7', '#14b8a6', '#f97316', '#ec4899'];

let localFilePromise = null;

/**
 * Chemin du fichier des instances locales.
 * @returns {Promise<string>}
 */
function localFile() {
    if (!localFilePromise) {
        localFilePromise = ipcRenderer.invoke('path-user-data').then(dir => path.join(dir, 'local-instances.json'));
    }
    return localFilePromise;
}

/**
 * Télécharge un JSON (APIs Mojang, Fabric, Quilt, Forge, NeoForge, Modrinth).
 * @param {string} url
 * @returns {Promise<any>}
 */
async function fetchJson(url) {
    let res = await nodeFetch(url, { timeout: TIMEOUT, headers: { 'User-Agent': 'Venstone-Launcher' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/* ------------------------------------------------------------------ */
/* Chemins                                                             */
/* ------------------------------------------------------------------ */

/**
 * Dossier du jeu (`%APPDATA%/.venstone`, ou `venstone` sous macOS).
 * @param {object} launcherConfig Configuration de l'API (dataDirectory)
 * @returns {Promise<string>}
 */
export async function getGamePath(launcherConfig) {
    let appdata = await ipcRenderer.invoke('appData');
    let dir = launcherConfig?.dataDirectory || 'venstone';
    return `${appdata}/${process.platform == 'darwin' ? dir : `.${dir}`}`;
}

/**
 * Dossier d'une instance.
 * @param {string} gamePath
 * @param {{name: string}} instance
 * @returns {string}
 */
export function instanceFolder(gamePath, instance) {
    return `${gamePath}/instances/${instance.name}`;
}

/**
 * Fichier de cache permettant de relancer l'instance hors-ligne.
 * @param {string} gamePath
 * @param {{name: string}} instance
 * @returns {string}
 */
export function launchCacheFile(gamePath, instance) {
    return `${gamePath}/launcher-cache/${instance.name.replace(FORBIDDEN_CHARS, '_')}.json`;
}

/** Une instance est jouable hors-ligne si elle a déjà été lancée une fois avec succès. */
export function isInstalled(gamePath, instance) {
    return fs.existsSync(launchCacheFile(gamePath, instance));
}

/* ------------------------------------------------------------------ */
/* Instances locales                                                   */
/* ------------------------------------------------------------------ */

/**
 * Instances créées par le joueur (marquées `local: true`).
 * @returns {Promise<object[]>}
 */
export async function getLocalInstances() {
    try {
        let file = await localFile();
        if (!fs.existsSync(file)) return [];
        let list = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(list) ? list.map(i => ({ ...i, local: true })) : [];
    } catch (err) {
        console.error('[Instances] lecture des instances locales impossible :', err);
        return [];
    }
}

/**
 * Enregistre la liste des instances locales (écriture atomique).
 * @param {object[]} list
 */
async function saveLocalInstances(list) {
    let file = await localFile();
    let clean = list.map(({ local, ...rest }) => rest);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(clean, null, 2));
    fs.renameSync(`${file}.tmp`, file);
}

/**
 * Nettoie un nom d'instance pour qu'il soit utilisable comme nom de dossier.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeName(name) {
    return (name || '').replace(FORBIDDEN_CHARS, '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').slice(0, 32);
}

/**
 * Vérifie qu'un nom d'instance est valide et libre.
 * @param {string} name
 * @param {object[]} officialList Instances officielles
 * @param {string|null} [exceptName] Instance en cours de renommage (ignorée)
 * @returns {Promise<{name?: string, error?: string}>}
 */
export async function validateName(name, officialList, exceptName = null) {
    let clean = sanitizeName(name);
    if (clean.length < 2) return { error: 'Le nom doit contenir au moins 2 caractères.' };
    let lower = clean.toLowerCase();
    let locals = (await getLocalInstances()).filter(i => i.name !== exceptName);
    if ([...officialList, ...locals].some(i => i.name.toLowerCase() === lower)) {
        return { error: 'Une instance porte déjà ce nom.' };
    }
    return { name: clean };
}

/**
 * Crée une instance locale (rien n'est téléchargé avant le premier lancement).
 * @param {object} data Valeurs du formulaire (voir InstanceForm#data)
 * @returns {Promise<object>}
 */
export async function createLocalInstance(data) {
    let list = await getLocalInstances();
    let instance = {
        name: data.name,
        color: data.color,
        icon: data.icon || null, // data URL PNG 128 px (icône personnalisée)
        created: Date.now(),
        loadder: {
            minecraft_version: data.minecraft_version,
            loadder_type: data.loadder_type,
            loadder_version: data.loadder_version
        },
        fabricApi: data.fabricApi || null,
        verify: false,
        ignored: [],
        whitelist: [],
        whitelistActive: false
    };
    list.push(instance);
    await saveLocalInstances(list);
    return { ...instance, local: true };
}

/**
 * Modifie une instance locale. Un renommage déplace aussi son dossier (mondes partagés :
 * seuls les liens sont déplacés). Un changement de version invalide le cache hors-ligne.
 * Renvoie l'instance mise à jour.
 */
export async function updateLocalInstance(name, changes, gamePath) {
    let list = await getLocalInstances();
    let index = list.findIndex(i => i.name === name);
    if (index < 0) throw new Error('Instance introuvable.');
    let current = list[index];
    let next = {
        ...current,
        ...changes,
        loadder: { ...current.loadder, ...(changes.loadder || {}) }
    };

    let versionChanged = ['minecraft_version', 'loadder_type', 'loadder_version']
        .some(key => next.loadder[key] !== current.loadder[key]);

    if (gamePath) {
        let oldDir = instanceFolder(gamePath, current);
        let oldCache = launchCacheFile(gamePath, current);
        if (next.name !== current.name) {
            let newDir = instanceFolder(gamePath, next);
            if (fs.existsSync(newDir)) throw new Error(`Un dossier "${next.name}" existe déjà dans les instances.`);
            if (fs.existsSync(oldDir)) {
                try {
                    fs.renameSync(oldDir, newDir);
                } catch (err) {
                    throw new Error(`Impossible de renommer le dossier (le jeu est-il encore ouvert ?) : ${err.message}`);
                }
            }
            if (fs.existsSync(oldCache) && !versionChanged) fs.renameSync(oldCache, launchCacheFile(gamePath, next));
        }
        // Le cache hors-ligne décrit l'ancienne version : on le supprime pour forcer un lancement en ligne.
        if (versionChanged) fs.rmSync(oldCache, { force: true });

        // Ancienne Fabric API retirée si elle a changé (la nouvelle est téléchargée au lancement).
        let oldApi = current.fabricApi?.filename;
        if (oldApi && oldApi !== next.fabricApi?.filename) {
            fs.rmSync(`${instanceFolder(gamePath, next)}/mods/${oldApi}`, { force: true });
        }
    }

    list[index] = next;
    await saveLocalInstances(list);
    return { ...next, local: true };
}

/**
 * Supprime une instance locale, et éventuellement ses fichiers.
 * Les liens vers les données partagées sont retirés avant, les mondes ne sont jamais supprimés.
 * @param {string} name
 * @param {string} gamePath
 * @param {boolean} deleteFiles
 */
export async function deleteLocalInstance(name, gamePath, deleteFiles) {
    let list = (await getLocalInstances()).filter(i => i.name !== name);
    await saveLocalInstances(list);
    if (deleteFiles && gamePath) {
        let target = { name };
        // Les mondes / captures sont des liens vers le dossier partagé : on retire les liens
        // d'abord pour être certain de ne jamais toucher aux données communes.
        unlinkSharedData(instanceFolder(gamePath, target));
        fs.rmSync(instanceFolder(gamePath, target), { recursive: true, force: true });
        fs.rmSync(launchCacheFile(gamePath, target), { force: true });
    }
}

/* ------------------------------------------------------------------ */
/* Sélection / whitelist                                               */
/* ------------------------------------------------------------------ */

/**
 * Le compte a-t-il accès à cette instance (whitelist) ?
 * @param {object} instance
 * @param {object} [auth] Compte
 * @returns {boolean}
 */
export function canUseInstance(instance, auth) {
    if (!instance.whitelistActive) return true;
    return (instance.whitelist || []).includes(auth?.name);
}

/** Toutes les instances visibles par le compte : officielles d'abord, puis locales. */
export async function getAllInstances(auth) {
    let official = (await config.getInstanceList()).filter(i => canUseInstance(i, auth));
    let locals = await getLocalInstances();
    return { official, locals, all: [...official, ...locals] };
}

/**
 * Renvoie le nom de l'instance à sélectionner pour ce compte : celle déjà choisie
 * si elle est toujours disponible, sinon la première officielle accessible.
 */
export async function resolveInstanceSelection(configClient, auth) {
    let { all } = await getAllInstances(auth);
    if (all.find(i => i.name == configClient?.instance_selct)) return configClient.instance_selct;
    return all[0]?.name || null;
}

/* ------------------------------------------------------------------ */
/* Versions disponibles (pour la création d'instance)                  */
/* ------------------------------------------------------------------ */

let manifestCache = null;
/**
 * Versions de Minecraft disponibles (manifest Mojang, mis en cache pour la session).
 * @returns {Promise<{latest: object, versions: Array<{id: string, type: string}>}>}
 */
export async function getMinecraftVersions() {
    if (!manifestCache) {
        manifestCache = fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json')
            .catch(err => { manifestCache = null; throw err; });
    }
    let manifest = await manifestCache;
    return {
        latest: manifest.latest,
        versions: manifest.versions.map(v => ({ id: v.id, type: v.type }))
    };
}

/**
 * Liste des builds de loader pour une version de Minecraft, du plus récent au plus ancien.
 * La logique de filtrage reproduit celle de minecraft-java-core pour ne proposer
 * que des builds réellement installables.
 */
export async function getLoaderVersions(type, mcVersion) {
    switch (type) {
        case 'fabric': {
            let list = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`);
            return list.map(l => ({ version: l.loader.version, stable: l.loader.stable !== false }));
        }
        case 'quilt': {
            let list = await fetchJson(`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mcVersion)}`);
            return list.map(l => ({ version: l.loader.version, stable: !/beta|alpha|rc|pre/i.test(l.loader.version) }));
        }
        case 'forge': {
            let meta = await fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json');
            let builds = meta[mcVersion] || [];
            let promos = await fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json').catch(() => ({ promos: {} }));
            let recommended = promos.promos?.[`${mcVersion}-recommended`];
            return builds.slice().reverse().map(b => ({
                version: b,
                label: b.replace(`${mcVersion}-`, ''),
                stable: recommended ? b === `${mcVersion}-${recommended}` || b.startsWith(`${mcVersion}-${recommended}-`) : true
            }));
        }
        case 'neoforge': {
            let [legacy, meta] = await Promise.all([
                fetchJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/forge'),
                fetchJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')
            ]);
            let versions = legacy.versions.filter(v => v.includes(`${mcVersion}-`));
            if (!versions.length) {
                let splitted = mcVersion.split('.');
                let shortVersion = `${splitted[1]}.${splitted[2] || 0}`;
                versions = meta.versions.filter(v => v.startsWith(`${shortVersion}.`));
            }
            return versions.slice().reverse().map(v => ({ version: v, stable: !/beta|alpha/i.test(v) }));
        }
        default:
            return [];
    }
}

/** Versions de Fabric API (Modrinth) compatibles avec la version de Minecraft. */
export async function getFabricApiVersions(mcVersion, loader = 'fabric') {
    let query = `game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}&loaders=${encodeURIComponent(JSON.stringify([loader]))}`;
    let list = await fetchJson(`https://api.modrinth.com/v2/project/fabric-api/version?${query}`);
    return list.map(v => {
        let file = v.files.find(f => f.primary) || v.files[0];
        return {
            version: v.version_number,
            stable: v.version_type === 'release',
            url: file?.url,
            filename: file?.filename,
            sha1: file?.hashes?.sha1
        };
    }).filter(v => v.url);
}

/** Télécharge Fabric API dans le dossier mods de l'instance si elle n'y est pas déjà. */
export async function ensureFabricApi(gamePath, instance) {
    let api = instance.fabricApi;
    if (!api?.url || !api?.filename) return;
    let modsDir = `${instanceFolder(gamePath, instance)}/mods`;
    let target = `${modsDir}/${api.filename}`;
    if (fs.existsSync(target)) return;
    fs.mkdirSync(modsDir, { recursive: true });
    let res = await nodeFetch(api.url, { timeout: 30000 });
    if (!res.ok) throw new Error(`Fabric API : HTTP ${res.status}`);
    let buffer = await res.buffer();
    if (api.sha1) {
        let hash = require('crypto').createHash('sha1').update(buffer).digest('hex');
        if (hash !== api.sha1) throw new Error('Fabric API : fichier corrompu (sha1 invalide)');
    }
    fs.writeFileSync(target, buffer);
}

/** Petit test de connectivité vers les serveurs Mojang (utilisé avant un lancement). */
export async function hasInternet() {
    try {
        let res = await nodeFetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json', { method: 'HEAD', timeout: 4000 });
        return res.ok;
    } catch {
        return false;
    }
}
