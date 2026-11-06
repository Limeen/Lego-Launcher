/**
 * Formulaire d'instance (nom, couleur, version de Minecraft, loader, Fabric API),
 * partagé par la fenêtre de création et celle d'édition.
 * Tous les éléments sont cherchés dans `root` avec les mêmes classes CSS.
 */

import { LOADERS, INSTANCE_COLORS, getMinecraftVersions, getLoaderVersions, getFabricApiVersions } from './instances.js';

/**
 * Échappe un texte pour l'insérer dans du HTML.
 * @param {any} text
 * @returns {string}
 */
export function escapeHTML(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Initiales affichées dans l'icône d'une instance (« Mes mods » → « MM »).
 * @param {string} name
 * @returns {string}
 */
export function initials(name) {
    let words = String(name).trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return String(name).slice(0, 2).toUpperCase();
}

/**
 * Libellé du loader d'une instance (ex. « Fabric 0.16.14 », « Vanilla »).
 * @param {object} instance
 * @returns {string}
 */
export function loaderLabel(instance) {
    let type = instance?.loadder?.loadder_type || 'none';
    let label = LOADERS[type]?.label || type;
    let build = instance?.loadder?.loadder_version;
    if (type === 'none' || !build || build === 'latest') return label;
    return `${label} ${String(build).replace(`${instance.loadder.minecraft_version}-`, '')}`;
}

export default class InstanceForm {
    constructor(root, { onChange } = {}) {
        this.root = root;
        this.onChange = onChange || (() => { });
        let q = s => root.querySelector(s);
        this.el = {
            name: q('.create-name'),
            swatches: q('.color-swatches'),
            mcVersion: q('.create-mc-version'),
            snapshots: q('.create-snapshots'),
            loader: q('.create-loader'),
            loaderField: q('.create-loader-field'),
            loaderVersion: q('.create-loader-version'),
            apiField: q('.create-fabricapi-field'),
            apiEnabled: q('.create-fabricapi-enabled'),
            apiVersion: q('.create-fabricapi-version'),
            error: q('.create-error')
        };
        this.state = { loader: 'none', color: INSTANCE_COLORS[0], loaderVersions: [], apiVersions: [] };
        this.preset = {};
        this.requestId = 0;
        this.bind();
    }

    /** Branche les événements des champs du formulaire. */
    bind() {
        let e = this.el;
        e.swatches.innerHTML = INSTANCE_COLORS.map(color => `<div class="swatch" data-color="${color}" style="background:${color}"></div>`).join('');
        e.swatches.addEventListener('click', ev => {
            let swatch = ev.target.closest('.swatch');
            if (!swatch) return;
            this.state.color = swatch.dataset.color;
            this.update();
        });
        e.loader.addEventListener('click', ev => {
            let segment = ev.target.closest('.segment');
            if (!segment || segment.classList.contains('active')) return;
            this.state.loader = segment.dataset.loader;
            this.update();
            this.loadLoaderVersions();
        });
        e.name.addEventListener('input', () => { this.setError(''); this.update(); });
        e.snapshots.addEventListener('change', () => this.fillMinecraftVersions());
        e.mcVersion.addEventListener('change', () => { this.update(); this.loadLoaderVersions(); });
        e.loaderVersion.addEventListener('change', () => this.update());
        e.apiVersion.addEventListener('change', () => this.update());
        e.apiEnabled.addEventListener('change', () => this.update());
    }

    /** Pré-remplit le formulaire (création : valeurs par défaut, édition : l'instance). */
    reset({ name = '', color = INSTANCE_COLORS[0], minecraft_version = null, loadder_type = 'none', loadder_version = null, fabricApi = undefined } = {}) {
        this.preset = { minecraft_version, loadder_version, fabricApi };
        this.state = { loader: loadder_type, color, loaderVersions: [], apiVersions: [] };
        this.el.name.value = name;
        this.el.apiEnabled.checked = fabricApi !== null;
        this.el.snapshots.checked = false;
        this.setError('');
        this.update();
    }

    /**
     * Affiche un message d'erreur sous le formulaire (vide = efface).
     * @param {string} text
     */
    setError(text) {
        if (this.el.error) this.el.error.textContent = text;
    }

    /**
     * Met une liste déroulante en attente / indisponible avec un message.
     * @param {HTMLSelectElement} select
     * @param {string} text
     */
    setSelectLoading(select, text) {
        select.innerHTML = `<option value="">${escapeHTML(text)}</option>`;
        select.disabled = true;
    }

    /** Hors-ligne : on garde au moins la valeur actuelle pour pouvoir enregistrer le reste. */
    setSelectFixed(select, value, label = value) {
        select.innerHTML = `<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`;
        select.value = value;
        select.disabled = false;
    }

    /**
     * Remplit la liste des versions de Minecraft (manifest Mojang) puis celle du loader.
     * Hors-ligne, garde la version actuelle de l'instance.
     */
    async fillMinecraftVersions() {
        let e = this.el;
        let previous = e.mcVersion.value || this.preset.minecraft_version;
        this.setSelectLoading(e.mcVersion, 'Chargement des versions...');
        try {
            let { versions, latest } = await getMinecraftVersions();
            // Une instance en snapshot : on affiche les snapshots pour pouvoir la garder.
            if (previous && versions.find(v => v.id === previous)?.type === 'snapshot') e.snapshots.checked = true;
            let list = versions.filter(v => v.type === 'release' || (e.snapshots.checked && v.type === 'snapshot'));
            e.mcVersion.innerHTML = list.map(v => {
                let tag = v.id === latest.release ? ' (dernière)' : v.type === 'snapshot' ? ' (snapshot)' : '';
                return `<option value="${escapeHTML(v.id)}">${escapeHTML(v.id)}${tag}</option>`;
            }).join('');
            e.mcVersion.disabled = false;
            e.mcVersion.value = list.some(v => v.id === previous) ? previous : latest.release;
        } catch (err) {
            console.error(err);
            if (this.preset.minecraft_version) this.setSelectFixed(e.mcVersion, this.preset.minecraft_version);
            else this.setSelectLoading(e.mcVersion, 'Impossible de charger les versions');
            this.setError('Connexion aux serveurs Mojang impossible.');
        }
        this.update();
        await this.loadLoaderVersions();
    }

    /**
     * Charge les versions du loader et de Fabric API pour la version de Minecraft choisie.
     * Les requêtes obsolètes (changement rapide de version) sont ignorées.
     */
    async loadLoaderVersions() {
        let e = this.el;
        let loader = this.state.loader;
        let mc = e.mcVersion.value;
        let requestId = ++this.requestId;
        this.state.loaderVersions = [];
        this.state.apiVersions = [];

        if (loader === 'none' || !mc) return this.update();

        this.setSelectLoading(e.loaderVersion, 'Chargement...');
        let withApi = loader === 'fabric' || loader === 'quilt';
        if (withApi) this.setSelectLoading(e.apiVersion, 'Chargement...');
        this.update();

        let [loaders, apis] = await Promise.all([
            getLoaderVersions(loader, mc).catch(err => { console.error(err); return null; }),
            withApi ? getFabricApiVersions(mc).catch(err => { console.error(err); return null; }) : Promise.resolve([])
        ]);
        if (requestId !== this.requestId) return; // une autre requête a pris le relais

        // Version actuelle de l'instance, à présélectionner si elle correspond toujours.
        let keepPreset = mc === this.preset.minecraft_version;

        if (loaders === null) {
            if (keepPreset && this.preset.loadder_version) this.setSelectFixed(e.loaderVersion, this.preset.loadder_version);
            else this.setSelectLoading(e.loaderVersion, 'Erreur de chargement');
        } else if (!loaders.length) {
            this.setSelectLoading(e.loaderVersion, `${LOADERS[loader].label} n'est pas disponible pour ${mc}`);
        } else {
            this.state.loaderVersions = loaders;
            let recommended = loaders.find(l => l.stable) || loaders[0];
            e.loaderVersion.innerHTML = loaders.map(l => {
                let tag = l === recommended ? ' (recommandée)' : !l.stable ? ' (bêta)' : '';
                return `<option value="${escapeHTML(l.version)}">${escapeHTML(l.label || l.version)}${tag}</option>`;
            }).join('');
            let preset = keepPreset && loaders.find(l => l.version === this.preset.loadder_version);
            e.loaderVersion.value = (preset || recommended).version;
            e.loaderVersion.disabled = false;
        }

        if (withApi) {
            let presetApi = this.preset.fabricApi;
            if (apis === null) {
                if (keepPreset && presetApi) {
                    this.state.apiVersions = [presetApi];
                    this.setSelectFixed(e.apiVersion, '0', presetApi.version);
                } else this.setSelectLoading(e.apiVersion, 'Erreur de chargement');
            } else if (!apis.length) {
                this.setSelectLoading(e.apiVersion, `Aucune version pour ${mc}`);
            } else {
                this.state.apiVersions = apis;
                e.apiVersion.innerHTML = apis.map((v, i) => `<option value="${i}">${escapeHTML(v.version)}${i === 0 ? ' (dernière)' : ''}</option>`).join('');
                let index = keepPreset && presetApi ? apis.findIndex(v => v.filename === presetApi.filename) : -1;
                e.apiVersion.value = String(index >= 0 ? index : 0);
                e.apiVersion.disabled = false;
            }
        }
        this.update();
    }

    /**
     * Valeurs actuelles du formulaire, au format d'une instance.
     * @returns {{name: string, color: string, minecraft_version: string, loadder_type: string, loadder_version: string, fabricApi: object|null}}
     */
    data() {
        let e = this.el;
        let loader = this.state.loader;
        let withApi = (loader === 'fabric' || loader === 'quilt') && e.apiEnabled.checked;
        let api = withApi ? this.state.apiVersions[Number(e.apiVersion.value)] : null;
        return {
            name: e.name.value.trim(),
            color: this.state.color,
            minecraft_version: e.mcVersion.value,
            loadder_type: loader,
            loadder_version: loader === 'none' ? 'latest' : e.loaderVersion.value,
            fabricApi: api ? { version: api.version, url: api.url, filename: api.filename, sha1: api.sha1 } : null
        };
    }

    /**
     * Le formulaire est-il complet (nom, version, loader chargés) ?
     * @returns {boolean}
     */
    ready() {
        let e = this.el;
        let data = this.data();
        if (!data.name || !data.minecraft_version || e.mcVersion.disabled) return false;
        if (data.loadder_type !== 'none' && (!data.loadder_version || e.loaderVersion.disabled)) return false;
        return true;
    }

    /** Rafraîchit l'affichage (loader actif, couleur, champs visibles, aperçu) puis appelle `onChange`. */
    update() {
        let e = this.el;
        let { loader, color } = this.state;
        let data = this.data();

        e.loader.querySelectorAll('.segment').forEach(s => s.classList.toggle('active', s.dataset.loader === loader));
        e.swatches.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s.dataset.color === color));
        e.loaderField.style.display = loader === 'none' ? 'none' : '';
        e.apiField.style.display = loader === 'fabric' || loader === 'quilt' ? '' : 'none';
        e.apiVersion.classList.toggle('dimmed', !e.apiEnabled.checked);

        // Aperçu (fenêtre de création uniquement)
        let icon = this.root.querySelector('.preview-icon');
        if (icon) {
            let previewName = data.name || 'Mon instance';
            icon.style.background = color;
            icon.textContent = initials(previewName);
            this.root.querySelector('.preview-name').textContent = previewName;
            let chips = [`<span class="loader-badge loader-${loader}">${escapeHTML(loaderLabel({ loadder: { loadder_type: loader, loadder_version: loader === 'none' || e.loaderVersion.disabled ? null : data.loadder_version, minecraft_version: data.minecraft_version } }))}</span>`];
            if (data.minecraft_version) chips.push(`<span class="chip">Minecraft ${escapeHTML(data.minecraft_version)}</span>`);
            if (data.fabricApi) chips.push(`<span class="chip">Fabric API ${escapeHTML(data.fabricApi.version.split('+')[0])}</span>`);
            this.root.querySelector('.preview-chips').innerHTML = chips.join('');
        }

        this.onChange(data);
    }
}
