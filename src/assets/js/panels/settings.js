/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

import { changePanel, accountSelect, database, popup, pkg } from '../utils.js'
import { getGamePath, resolveInstanceSelection, instanceFolder } from '../utils/instances.js'
import { sharedPath } from '../utils/shared.js'
const { shell } = require('electron');
const fs = require('fs');
const os = require('os');

const DEFAULT_RESOLUTION = { width: 854, height: 480 };
const DEFAULT_DOWNLOADS = 5;

class Settings {
    static id = "settings";
    async init(config) {
        this.config = config;
        this.db = new database();
        this.gamePath = await getGamePath(config);
        document.querySelector('.launcher-version').textContent = `Version ${pkg.version}`;

        this.navBTN()
        this.accounts()
        this.ram()
        this.resolution()
        this.jvmArgs()
        this.javaPath()
        this.launcher()
        this.folders()
    }

    /**
     * Lit la config, applique `fn` puis sauvegarde. Les mises à jour sont mises en file :
     * sans ça, deux réglages modifiés coup sur coup s'écrasaient l'un l'autre.
     */
    updateConfig(fn) {
        this.configQueue = (this.configQueue || Promise.resolve()).then(async () => {
            let configClient = await this.db.readData('configClient');
            fn(configClient);
            await this.db.updateData('configClient', configClient);
            return configClient;
        }).catch(err => console.error('[Paramètres] sauvegarde impossible :', err));
        return this.configQueue;
    }

    navBTN() {
        document.querySelector('.nav-settings').addEventListener('click', e => {
            let btn = e.target.closest('.nav-settings-btn, .nav-back');
            if (!btn) return;

            if (btn.id == 'save') {
                this.showTab('account');
                return changePanel('home');
            }
            this.showTab(btn.id);
        })
    }

    showTab(id) {
        document.querySelector('.active-settings-BTN')?.classList.remove('active-settings-BTN');
        document.querySelector(`.nav-settings-btn#${id}`).classList.add('active-settings-BTN');
        document.querySelector('.active-container-settings')?.classList.remove('active-container-settings');
        document.querySelector(`#${id}-tab`).classList.add('active-container-settings');
    }

    /* ------------------------------------------------------------------ */
    /* Comptes                                                             */
    /* ------------------------------------------------------------------ */

    accounts() {
        document.querySelector('.accounts-list').addEventListener('click', async e => {
            let deleteBTN = e.target.closest('.delete-profile');
            let card = e.target.closest('.account');
            if (!card) return;

            if (card.id == 'add') {
                document.querySelector('.cancel-home').style.display = 'inline';
                return changePanel('login');
            }

            let popupAccount = new popup();
            try {
                if (deleteBTN) {
                    let id = card.id;
                    popupAccount.openPopup({ title: 'Suppression', content: 'Veuillez patienter...', color: 'var(--color)' });
                    await this.db.deleteData('accounts', id);
                    card.remove();

                    let allAccounts = await this.db.readAllData('accounts');
                    if (!allAccounts.length) return changePanel('login');

                    let configClient = await this.db.readData('configClient');
                    if (configClient.account_selected == id) {
                        let newConfig = await this.setInstance(allAccounts[0]);
                        newConfig.account_selected = allAccounts[0].ID;
                        await this.db.updateData('configClient', newConfig);
                        await accountSelect(allAccounts[0]);
                    }
                    return;
                }

                if (card.classList.contains('account-select')) return;
                popupAccount.openPopup({ title: 'Connexion', content: 'Veuillez patienter...', color: 'var(--color)' });
                let account = await this.db.readData('accounts', card.id);
                let configClient = await this.setInstance(account);
                configClient.account_selected = account.ID;
                await this.db.updateData('configClient', configClient);
                await accountSelect(account);
            } catch (err) {
                console.error(err);
            } finally {
                popupAccount.closePopup();
            }
        })
    }

    async setInstance(auth) {
        let configClient = await this.db.readData('configClient');
        configClient.instance_selct = await resolveInstanceSelection(configClient, auth);
        return configClient;
    }

    /* ------------------------------------------------------------------ */
    /* Jeu                                                                 */
    /* ------------------------------------------------------------------ */

    async ram() {
        let configClient = await this.db.readData('configClient');
        let totalMem = Math.trunc(os.totalmem() / 1073741824 * 10) / 10;
        let maxAllowed = Math.max(1, Math.floor(totalMem * 0.8 * 2) / 2);
        let recommended = Math.min(8, Math.max(2, Math.floor(totalMem * 0.4 * 2) / 2));

        let minInput = document.querySelector('.ram-min');
        let maxInput = document.querySelector('.ram-max');
        let fill = document.querySelector('.ram-meter-fill');
        minInput.max = maxAllowed;
        maxInput.max = maxAllowed;

        let ram = configClient?.java_config?.java_memory || { min: 2, max: 4 };
        let min = Math.min(parseFloat(ram.min) || 2, maxAllowed);
        let max = Math.min(parseFloat(ram.max) || 4, maxAllowed);
        if (min > max) min = max;

        let paint = (input) => {
            let ratio = (input.value - input.min) / (input.max - input.min);
            input.style.setProperty('--fill', `${Math.max(0, Math.min(1, ratio)) * 100}%`);
        };

        let render = () => {
            document.querySelector('.ram-min-value').textContent = `${minInput.value} Go`;
            document.querySelector('.ram-max-value').textContent = `${maxInput.value} Go`;
            document.querySelector('.ram-meter-game').textContent = `${maxInput.value} Go`;
            let freeMem = Math.trunc(os.freemem() / 1073741824 * 10) / 10;
            document.getElementById("free-ram").textContent = `${freeMem} Go`;
            document.getElementById("total-ram").textContent = `${totalMem} Go`;
            let percent = (maxInput.value / totalMem) * 100;
            fill.style.width = `${Math.min(100, percent)}%`;
            fill.classList.toggle('warn', percent > 60);
            paint(minInput);
            paint(maxInput);
        };

        let save = () => this.updateConfig(c => {
            c.java_config.java_memory = { min: parseFloat(minInput.value), max: parseFloat(maxInput.value) };
        });

        minInput.value = min;
        maxInput.value = max;
        render();

        minInput.addEventListener('input', () => {
            if (parseFloat(minInput.value) > parseFloat(maxInput.value)) maxInput.value = minInput.value;
            render();
        });
        maxInput.addEventListener('input', () => {
            if (parseFloat(maxInput.value) < parseFloat(minInput.value)) minInput.value = maxInput.value;
            render();
        });
        minInput.addEventListener('change', save);
        maxInput.addEventListener('change', save);

        document.querySelector('.ram-recommended').addEventListener('click', () => {
            maxInput.value = Math.min(recommended, maxAllowed);
            minInput.value = Math.min(2, maxInput.value);
            render();
            save();
        });

        // La RAM libre évolue : on la rafraîchit à l'ouverture de l'onglet.
        document.querySelector('.nav-settings-btn#game').addEventListener('click', render);
    }

    async resolution() {
        let configClient = await this.db.readData('configClient');
        let resolution = configClient?.game_config?.screen_size || DEFAULT_RESOLUTION;

        let width = document.querySelector(".width-size");
        let height = document.querySelector(".height-size");
        let presets = document.querySelector('.resolution-presets');
        let fullscreen = document.querySelector('.fullscreen-toggle');

        let markPreset = () => presets.querySelectorAll('.chip-btn').forEach(chip =>
            chip.classList.toggle('active', chip.dataset.w == width.value && chip.dataset.h == height.value));

        let save = () => this.updateConfig(c => {
            c.game_config.screen_size = {
                width: Math.max(320, parseInt(width.value) || DEFAULT_RESOLUTION.width),
                height: Math.max(240, parseInt(height.value) || DEFAULT_RESOLUTION.height)
            };
        });

        width.value = resolution.width;
        height.value = resolution.height;
        fullscreen.checked = !!configClient?.game_config?.fullscreen;
        markPreset();

        for (let input of [width, height]) {
            input.addEventListener('input', markPreset);
            input.addEventListener('change', save);
        }

        presets.addEventListener('click', e => {
            let chip = e.target.closest('.chip-btn');
            if (!chip) return;
            width.value = chip.dataset.w;
            height.value = chip.dataset.h;
            markPreset();
            save();
        });

        fullscreen.addEventListener('change', () => this.updateConfig(c => { c.game_config.fullscreen = fullscreen.checked }));
    }

    async jvmArgs() {
        let configClient = await this.db.readData('configClient');
        let input = document.querySelector('.jvm-args');
        input.value = configClient?.java_config?.jvm_args || '';
        input.addEventListener('change', () => this.updateConfig(c => { c.java_config.jvm_args = input.value.trim() }));
    }

    /* ------------------------------------------------------------------ */
    /* Java                                                                */
    /* ------------------------------------------------------------------ */

    async javaPath() {
        let runtime = `${this.gamePath}/runtime`;
        document.querySelector(".java-path-txt").textContent = runtime;

        let javaPathInputTxt = document.querySelector(".java-path-input-text");
        let javaPathInputFile = document.querySelector(".java-path-input-file");
        let pill = document.querySelector('.java-mode-pill');
        let desc = document.querySelector('.java-mode-desc');

        let render = (path) => {
            javaPathInputTxt.value = path || 'Java est géré automatiquement par le launcher.';
            pill.textContent = path ? 'Personnalisé' : 'Automatique';
            pill.classList.toggle('custom', !!path);
            desc.textContent = path
                ? 'Cet exécutable est utilisé pour toutes les instances. Vérifiez qu\'il correspond à la version de Minecraft.'
                : 'La bonne version de Java est téléchargée et choisie pour chaque instance.';
        };

        let configClient = await this.db.readData('configClient');
        render(configClient?.java_config?.java_path);

        document.querySelector(".java-path-set").addEventListener("click", () => {
            javaPathInputFile.value = '';
            javaPathInputFile.click();
        });

        javaPathInputFile.addEventListener('change', async () => {
            let file = javaPathInputFile.files[0]?.path;
            if (!file) return;
            let name = file.split(/[\\/]/).pop().replace(/\.exe$/i, '');
            if (name !== 'java' && name !== 'javaw') {
                return new popup().openPopup({ title: 'Fichier invalide', content: 'Sélectionnez un fichier nommé java ou javaw.', color: 'red', options: true });
            }
            await this.updateConfig(c => { c.java_config.java_path = file });
            render(file);
        });

        document.querySelector(".java-path-reset").addEventListener("click", async () => {
            await this.updateConfig(c => { c.java_config.java_path = null });
            render(null);
        });

        document.querySelector('.open-runtime').addEventListener('click', () => this.openFolder(runtime));
    }

    /* ------------------------------------------------------------------ */
    /* Launcher                                                            */
    /* ------------------------------------------------------------------ */

    async launcher() {
        let configClient = await this.db.readData('configClient');

        let maxFiles = document.querySelector(".max-files");
        maxFiles.value = configClient?.launcher_config?.download_multi || DEFAULT_DOWNLOADS;
        let saveFiles = (value) => {
            value = Math.max(1, Math.min(30, parseInt(value) || DEFAULT_DOWNLOADS));
            maxFiles.value = value;
            return this.updateConfig(c => { c.launcher_config.download_multi = value });
        };
        maxFiles.addEventListener('change', () => saveFiles(maxFiles.value));
        document.querySelector('.max-files-minus').addEventListener('click', () => saveFiles(parseInt(maxFiles.value) - 1));
        document.querySelector('.max-files-plus').addEventListener('click', () => saveFiles(parseInt(maxFiles.value) + 1));

        let closeBox = document.querySelector(".close-box");
        let closeLauncher = configClient?.launcher_config?.closeLauncher || "close-launcher";
        document.querySelector(`.${closeLauncher}`)?.classList.add('active-close');

        closeBox.addEventListener("click", async e => {
            let card = e.target.closest('.close-btn');
            if (!card || card.classList.contains('active-close')) return;
            document.querySelector('.active-close')?.classList.remove('active-close');
            card.classList.add('active-close');
            let mode = ['close-launcher', 'close-all', 'close-none'].find(c => card.classList.contains(c));
            await this.updateConfig(c => { c.launcher_config.closeLauncher = mode });
        })
    }

    folders() {
        document.querySelector('.folder-grid').addEventListener('click', async e => {
            let btn = e.target.closest('.folder-btn');
            if (!btn) return;
            let target = this.gamePath;
            if (btn.dataset.folder === 'saves') target = `${sharedPath(this.gamePath)}/saves`;
            if (btn.dataset.folder === 'screenshots') target = `${sharedPath(this.gamePath)}/screenshots`;
            if (btn.dataset.folder === 'logs') {
                let configClient = await this.db.readData('configClient');
                let name = configClient?.instance_selct;
                if (name) target = `${instanceFolder(this.gamePath, { name })}/logs`;
            }
            this.openFolder(target);
        });
    }

    openFolder(folder) {
        fs.mkdirSync(folder, { recursive: true });
        shell.openPath(folder);
    }
}
export default Settings;
