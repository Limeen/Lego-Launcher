/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 *
 * Accès à l'API Venstone avec cache local : si l'API est injoignable, on
 * réutilise la dernière réponse connue pour que le launcher reste utilisable
 * hors-ligne.
 */

const nodeFetch = require("node-fetch");
const convert = require('xml-js');
const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');

const PRIMARY_URL = "https://venstone.xyz/launcher-data/stable";
const FALLBACK_URL = "http://launcher-data.alwaysdata.net/stable";
const TIMEOUT = 6000;

// Utilisée si l'API n'a jamais été jointe (premier lancement sans internet).
const DEFAULT_CONFIG = {
    maintenance: false,
    maintenance_message: "Le launcher est en maintenance.",
    online: false,
    client_id: "13f589e1-e2fc-443e-a68a-63b0092b8eeb",
    dataDirectory: "venstone"
};

let basePromise = null;
let configPromise = null;
let cacheDirPromise = null;

/**
 * Détermine (une fois par session) quel serveur de l'API répond : principal, secours,
 * ou aucun (mode hors-ligne).
 * @returns {Promise<string|null>}
 */
function resolveBaseUrl() {
    if (!basePromise) {
        basePromise = (async () => {
            for (let base of [PRIMARY_URL, FALLBACK_URL]) {
                try {
                    let res = await nodeFetch(`${base}/launcher/config-launcher/config.json`, { method: "HEAD", timeout: TIMEOUT });
                    if (res.ok) return base;
                    console.warn(`[Launcher] ${base} → status ${res.status}`);
                } catch (err) {
                    console.warn(`[Launcher] ${base} injoignable :`, err.message);
                }
            }
            console.warn("[Launcher] Aucun serveur joignable → mode hors-ligne");
            return null;
        })();
    }
    return basePromise;
}

/**
 * Dossier du cache de l'API (`<userData>/launcher-api-cache`).
 * @returns {Promise<string>}
 */
async function cacheDir() {
    if (!cacheDirPromise) {
        cacheDirPromise = ipcRenderer.invoke('path-user-data').then(dir => {
            // Pas "cache" : sous Windows ce serait le même dossier que "Cache" (cache HTTP de Chromium).
            let cache = path.join(dir, 'launcher-api-cache');
            if (!fs.existsSync(cache)) fs.mkdirSync(cache, { recursive: true });
            return cache;
        });
    }
    return cacheDirPromise;
}

/**
 * Lit une réponse de l'API mise en cache.
 * @param {string} name Nom de la ressource (config, instances, news)
 * @returns {Promise<any|null>}
 */
async function readCache(name) {
    try {
        let file = path.join(await cacheDir(), `${name}.json`);
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        console.warn(`[Cache] lecture ${name} impossible :`, err.message);
        return null;
    }
}

/**
 * Enregistre une réponse de l'API dans le cache (écriture atomique).
 * @param {string} name Nom de la ressource
 * @param {any} data
 */
async function writeCache(name, data) {
    try {
        let file = path.join(await cacheDir(), `${name}.json`);
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
        fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
        console.warn(`[Cache] écriture ${name} impossible :`, err.message);
    }
}

/**
 * Télécharge un JSON avec délai d'expiration ; lève une erreur si le statut n'est pas 200.
 * @param {string} url
 * @returns {Promise<any>}
 */
async function fetchJson(url) {
    let res = await nodeFetch(url, { timeout: TIMEOUT });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

class Config {
    /** true si l'API Venstone n'a pas pu être jointe pendant cette session. */
    async isOffline() {
        return (await resolveBaseUrl()) === null;
    }

    /**
     * Ne rejette jamais : renvoie la config en ligne, sinon la dernière en cache,
     * sinon la config par défaut. `offline: true` est ajouté hors connexion.
     */
    GetConfig() {
        if (!configPromise) {
            configPromise = (async () => {
                let base = await resolveBaseUrl();
                if (base) {
                    try {
                        let data = await fetchJson(`${base}/launcher/config-launcher/config.json`);
                        await writeCache('config', data);
                        return { ...DEFAULT_CONFIG, ...data, offline: false };
                    } catch (err) {
                        console.warn('[Config] récupération impossible :', err.message);
                    }
                }
                let cached = await readCache('config');
                return { ...DEFAULT_CONFIG, ...(cached || {}), maintenance: false, offline: true };
            })();
        }
        return configPromise;
    }

    /** Instances officielles (API), avec repli sur le cache. */
    async getInstanceList() {
        let base = await resolveBaseUrl();
        let instances = null;

        if (base) {
            try {
                instances = await fetchJson(`${base}/files/`);
                await writeCache('instances', instances);
            } catch (err) {
                console.warn('[Instances] récupération impossible :', err.message);
            }
        }
        if (!instances) instances = (await readCache('instances')) || {};

        let instancesList = [];
        for (let [name, data] of Object.entries(instances)) {
            if (!data || typeof data !== 'object') continue;
            instancesList.push({ ...data, name, official: true });
        }
        return instancesList;
    }

    /**
     * Actualités du launcher (JSON ou flux RSS), avec repli sur le cache.
     * @returns {Promise<Array<{title: string, content: string, author: string, publish_date: string}>>}
     */
    async getNews() {
        let base = await resolveBaseUrl();
        let config = await this.GetConfig();

        if (base) {
            try {
                let news = config.rss ? await this.fetchRss(config.rss) : await fetchJson(`${base}/launcher/news-launcher/news.json`);
                await writeCache('news', news);
                return news;
            } catch (err) {
                console.warn('[News] récupération impossible :', err.message);
            }
        }
        let cached = await readCache('news');
        if (cached) return cached;
        throw { error: { code: 'offline', message: 'server not accessible' } };
    }

    /**
     * Convertit un flux RSS en liste d'actualités.
     * @param {string} url
     * @returns {Promise<Array>}
     */
    async fetchRss(url) {
        let res = await nodeFetch(url, { timeout: TIMEOUT });
        if (res.status !== 200) throw new Error(res.statusText);
        let response = JSON.parse(convert.xml2json(await res.text(), { compact: true }))?.rss?.channel?.item;
        if (!response) return [];
        if (!Array.isArray(response)) response = [response];
        return response.map(item => ({
            title: item.title?._text,
            content: item['content:encoded']?._text || '',
            author: item['dc:creator']?._text || '',
            publish_date: item.pubDate?._text
        }));
    }
}

export default new Config;
