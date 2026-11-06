/**
 * Surcouche de minecraft-java-core permettant de jouer hors-ligne.
 *
 * Après chaque lancement en ligne réussi, on enregistre ce dont le jeu a besoin pour
 * démarrer (JSON de version, JSON du loader, chemin de Java) dans
 * `<gamePath>/launcher-cache/<instance>.json`. Sans connexion, on saute toute la phase
 * de téléchargement et on relance le jeu à partir de ce cache.
 */

const { Launch } = require('minecraft-java-core');
const fs = require('fs');
const path = require('path');

const NEVER_INSTALLED = "Cette instance n'a encore jamais été installée.<br>Connectez-vous à internet pour la télécharger une première fois.";

export default class OfflineLaunch extends Launch {
    constructor({ cacheFile, offline }) {
        super();
        this.cacheFile = cacheFile;
        this.forceOffline = !!offline;
        this.usedCache = false;
    }

    readCache() {
        try {
            if (!fs.existsSync(this.cacheFile)) return null;
            let data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
            let javaPath = this.options.java.path || data?.minecraftJava?.path;
            if (!data?.minecraftJson || !javaPath || !fs.existsSync(javaPath)) return null;
            return data;
        } catch (err) {
            console.warn('[OfflineLaunch] cache illisible :', err.message);
            return null;
        }
    }

    writeCache(data) {
        try {
            fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
            // Sérialisé immédiatement : start() modifie ensuite les JSON en place.
            let payload = JSON.stringify({
                savedAt: Date.now(),
                minecraftJson: data.minecraftJson,
                minecraftLoader: data.minecraftLoader,
                minecraftVersion: data.minecraftVersion,
                minecraftJava: { path: data.minecraftJava?.path, files: [] }
            });
            fs.writeFileSync(`${this.cacheFile}.tmp`, payload);
            fs.renameSync(`${this.cacheFile}.tmp`, this.cacheFile);
        } catch (err) {
            console.warn('[OfflineLaunch] impossible d\'écrire le cache :', err.message);
        }
    }

    useCache() {
        let cached = this.readCache();
        if (!cached) return { error: NEVER_INSTALLED };
        this.usedCache = true;
        this.emit('offline');
        return cached;
    }

    async DownloadGame() {
        if (this.forceOffline) return this.useCache();

        let errorEmitted = false;
        // Les erreurs de téléchargement d'un fichier (instances d'Error) ne sont pas
        // bloquantes : la lib continue. Seules les erreurs "objet" stoppent le lancement.
        let onError = err => { if (!(err instanceof Error)) errorEmitted = true; };
        this.on('error', onError);

        try {
            let data = await super.DownloadGame();
            if (data && typeof data === 'object' && !data.error && data.minecraftJson) {
                this.writeCache(data);
                return data;
            }
            // Erreur renvoyée (pas levée) : la lib a peut-être déjà émis 'error'.
            if (errorEmitted) return { error: null, silent: true };
            return data && typeof data === 'object' ? data : { error: 'Erreur inconnue pendant le téléchargement.' };
        } catch (err) {
            // Typiquement : fetch impossible (pas d'internet, serveur down).
            console.warn('[OfflineLaunch] téléchargement impossible, utilisation du cache :', err?.message || err);
            return this.useCache();
        } finally {
            this.removeListener('error', onError);
        }
    }

    async start() {
        try {
            let data = await this.DownloadGame();
            if (data?.silent) return; // erreur déjà signalée
            if (data?.error) return this.emit('error', data);
            this.DownloadGame = async () => data;
            return await super.start();
        } catch (err) {
            this.emit('error', { error: err?.message || String(err) });
        }
    }
}
