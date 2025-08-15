/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const nodeFetch = require("node-fetch");
const convert = require('xml-js');

let url = "https://venstone.xyz/launcher-data/stable";
let fallbackUrl = "http://launcher-data.alwaysdata.net/stable";

let configUrl = `${url}/launcher/config-launcher/config.json`;
let newsUrl = `${url}/launcher/news-launcher/news.json`;

async function ensureUrl() {
    try {
        let res = await nodeFetch(configUrl, { method: "HEAD" });
        if (!res.ok) throw new Error(`status ${res.status}`);
    } catch (err) {
        console.warn("[Launcher] Serveur principal injoignable → bascule sur fallback :", err.message);
        url = fallbackUrl;
        configUrl = `${url}/launcher/config-launcher/config.json`;
        newsUrl = `${url}/launcher/news-launcher/news.json`;
    }
}

class Config {
    async GetConfig() {
        await ensureUrl();

        return new Promise((resolve, reject) => {
            nodeFetch(configUrl).then(async res => {
                if (res.status === 200) return resolve(res.json());
                else {
                    return reject({
                        error: {
                            code: "Erreur",
                            message: "❌ Aucune connexion internet ou impossible de se connecter aux services Venstone."
                        }
                    });
                }
            }).catch(error => {
                return reject({
                    error: {
                        code: "Erreur",
                        message: "❌ Aucune connexion internet ou impossible de se connecter aux services Venstone."
                    }
                });
            });
        });
    }

    async getInstanceList() {
        await ensureUrl();

        let urlInstance = `${url}/files`;
        let instances = await nodeFetch(urlInstance).then(res => res.json()).catch(err => err);
        let instancesList = [];
        instances = Object.entries(instances);

        for (let [name, data] of instances) {
            let instance = data;
            instance.name = name;
            instancesList.push(instance);
        }
        return instancesList;
    }

    async getNews() {
        await ensureUrl();

        let config = await this.GetConfig() || {};

        if (config.rss) {
            return new Promise((resolve, reject) => {
                nodeFetch(config.rss).then(async res => {
                    if (res.status === 200) {
                        let news = [];
                        let response = await res.text();
                        response = (JSON.parse(convert.xml2json(response, { compact: true })))?.rss?.channel?.item;

                        if (!Array.isArray(response)) response = [response];
                        for (let item of response) {
                            news.push({
                                title: item.title._text,
                                content: item['content:encoded']._text,
                                author: item['dc:creator']._text,
                                publish_date: item.pubDate._text
                            });
                        }
                        return resolve(news);
                    }
                    else return reject({ error: { code: res.statusText, message: 'server not accessible' } });
                }).catch(error => reject({ error }));
            });
        } else {
            return new Promise((resolve, reject) => {
                nodeFetch(newsUrl).then(async res => {
                    if (res.status === 200) return resolve(res.json());
                    else return reject({ error: { code: res.statusText, message: 'server not accessible' } });
                }).catch(error => reject({ error }));
            });
        }
    }
}

export default new Config;
