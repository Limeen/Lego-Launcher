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

function localFile() {
    if (!localFilePromise) {
        localFilePromise = ipcRenderer.invoke('path-user-data').then(dir => path.join(dir, 'local-instances.json'));
    }
    return localFilePromise;
}

async function fetchJson(url) {
    let res = await nodeFetch(url, { timeout: TIMEOUT, headers: { 'User-Agent': 'Venstone-Launcher' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/* ------------------------------------------------------------------ */
/* Chemins                                                             */
/* ------------------------------------------------------------------ */

export async function getGamePath(launcherConfig) {
    let appdata = await ipcRenderer.invoke('appData');
    let dir = launcherConfig?.dataDirectory || 'venstone';
    return `${appdata}/${process.platform == 'darwin' ? dir : `.${dir}`}`;
}

export function instanceFolder(gamePath, instance) {
    return `${gamePath}/instances/${instance.name}`;
}

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

async function saveLocalInstances(list) {
    let file = await localFile();
    let clean = list.map(({ local, ...rest }) => rest);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(clean, null, 2));
    fs.renameSync(`${file}.tmp`, file);
}

export function sanitizeName(name) {
    return (name || '').replace(FORBIDDEN_CHARS, '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').slice(0, 32);
}

export async function validateName(name, officialList) {
    let clean = sanitizeName(name);
    if (clean.length < 2) return { error: 'Le nom doit contenir au moins 2 caractères.' };
    let lower = clean.toLowerCase();
    let locals = await getLocalInstances();
    if ([...officialList, ...locals].some(i => i.name.toLowerCase() === lower)) {
        return { error: 'Une instance porte déjà ce nom.' };
    }
    return { name: clean };
}

export async function createLocalInstance(data) {
    let list = await getLocalInstances();
    let instance = {
        name: data.name,
        color: data.color,
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
