/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const nodeFetch = require("node-fetch");
const convert = require('xml-js');

let url = pkg.user ? `${pkg.url}/${pkg.user}` : pkg.url;
let configUrl = `${url}/launcher/config-launcher/config.json`;
let newsUrl = `${url}/launcher/news-launcher/news.json`;

class Config {
    async GetConfig() {
        try {
            const res = await nodeFetch(configUrl);
            if (res.status === 200) return await res.json();
            console.warn(`Server returned status ${res.status} for config.json`);
            throw new Error('Server not accessible');
        } catch (error) {
            console.warn('Falling back to offline config.json');
            try {
                const filePath = path.join(__dirname, '../offline_mode/config.json');
                const rawData = fs.readFileSync(filePath, 'utf-8');
                return JSON.parse(rawData);
            } catch (err) {
                console.error('Failed to load offline config.json:', err);
                throw { error: { message: 'Unable to load config.json online or offline', details: err } };
            }
        }
    }

    async getInstanceList() {
        const urlInstance = `${url}/files`;
        let instancesList = [];

        try {
            const res = await nodeFetch(urlInstance);
            const contentType = res.headers.get("content-type") || "";
            if (!contentType.includes("application/json")) {
                throw new Error("Invalid content-type: " + contentType);
            }

            let instances = await res.json();
            if (typeof instances !== 'object' || instances === null) {
                throw new Error("Invalid JSON structure");
            }

            for (let [name, data] of Object.entries(instances)) {
                if (typeof data !== 'object' || data === null) {
                    console.warn(`Skipping invalid or null instance: ${name}`);
                    continue;
                }
                let instance = { ...data, name };
                instancesList.push(instance);
            }

        } catch (err) {
            console.error("Error fetching instance list:", err);
        }

        return instancesList;
    }

    async getNews() {
        try {
            let config = await this.GetConfig() || {};

            // Use RSS feed if specified
            if (config.rss) {
                try {
                    const res = await nodeFetch(config.rss);
                    if (res.status !== 200) throw new Error("RSS server not accessible");

                    let responseText = await res.text();
                    let parsed = JSON.parse(convert.xml2json(responseText, { compact: true }));
                    let items = parsed?.rss?.channel?.item;

                    if (!items) throw new Error("Invalid RSS structure");

                    if (!Array.isArray(items)) items = [items];

                    return items.map(item => ({
                        title: item.title._text,
                        content: item['content:encoded']._text,
                        author: item['dc:creator']._text,
                        publish_date: item.pubDate._text
                    }));
                } catch (err) {
                    console.warn('Failed to load RSS feed, trying fallback news.json...');
                }
            }

            // If no RSS or it fails, fallback to news.json
            const res = await nodeFetch(newsUrl);
            if (res.status === 200) {
                return await res.json();
            } else {
                throw new Error('Server not accessible');
            }

        } catch (error) {
            console.warn('Falling back to offline news.json');
            try {
                const filePath = path.join(__dirname, '../offline_mode/news.json');
                const rawData = fs.readFileSync(filePath, 'utf-8');
                return JSON.parse(rawData);
            } catch (err) {
                console.error('Failed to load offline news.json:', err);
                throw { error: { message: 'Unable to load news.json online or offline', details: err } };
            }
        }
    }
}

export default new Config;