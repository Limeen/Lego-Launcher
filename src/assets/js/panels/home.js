/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */
import { config, database, logger, changePanel, setStatus, pkg, popup } from '../utils.js'
import OfflineLaunch from '../utils/launch.js'
import { prepareSharedData, finishSharedData } from '../utils/shared.js'
import {
    INSTANCE_COLORS, getGamePath, getAllInstances, resolveInstanceSelection, isInstalled,
    launchCacheFile, instanceFolder, validateName, createLocalInstance, cloneOfficialInstance, ensureFabricApi, hasInternet
} from '../utils/instances.js'
import InstanceForm, { escapeHTML, loaderLabel, paintIcon } from '../utils/instanceForm.js'
import InstanceEditor from './instanceEditor.js'
import { confirmDialog } from '../utils/dialog.js'

const { shell, ipcRenderer } = require('electron')
const fs = require('fs')

const ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/></svg>'
const ICON_GEAR = '<svg viewBox="0 0 24 24"><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>'

/**
 * Barre de progression du lancement.
 * - set()           : progression réelle (téléchargement / vérification), animée en douceur.
 * - indeterminate() : phases où la lib n'envoie rien (vérification des fichiers, installation du
 *                     loader...) : animation continue, la barre ne paraît jamais figée.
 * Si plus aucun événement n'arrive après une progression, on repasse en indéterminé.
 */
class LaunchProgress {
    constructor(bar, label) {
        this.bar = bar
        this.fill = bar.querySelector('.progress-fill')
        this.label = label
        this.timer = null
        this.idle = null
        this.noteText = ''
    }

    /**
     * Texte affiché au-dessus de la barre (avec la note éventuelle).
     * @param {string} text HTML
     */
    setLabel(text) {
        this.label.innerHTML = this.noteText ? `${text}<div class="progress-note">${this.noteText}</div>` : text
    }

    /** Annule les minuteries de la barre. */
    clearTimers() {
        clearInterval(this.timer)
        clearTimeout(this.idle)
    }

    /**
     * Mode indéterminé : animation continue, pour les phases sans progression connue.
     * @param {string} text
     */
    indeterminate(text) {
        this.clearTimers()
        this.bar.style.display = ''
        this.bar.classList.add('indeterminate')
        this.fill.style.width = ''
        this.setLabel(text)
    }

    /**
     * Progression réelle.
     * @param {number} value
     * @param {number} size
     * @param {string} text Libellé de la phase (Téléchargement, Vérification...)
     */
    set(value, size, text) {
        this.clearTimers()
        let percent = Math.max(0, Math.min(100, (value / size) * 100))
        this.bar.style.display = ''
        this.bar.classList.remove('indeterminate')
        this.fill.style.width = `${percent}%`
        this.setLabel(`${text} <b>${percent.toFixed(0)}%</b>`)
        // La lib enchaîne souvent sur une phase silencieuse : on évite une barre bloquée.
        let finished = percent >= 99
        this.idle = setTimeout(() => this.indeterminate(finished ? 'Préparation du jeu...' : `${text}...`), finished ? 800 : 4000)
    }

    /**
     * Ajoute une note discrète sous le texte (ex. erreurs réseau).
     * @param {string} text
     */
    note(text) {
        this.noteText = text
    }

    /**
     * Masque la barre et affiche un texte final (« En jeu »).
     * @param {string} text
     */
    done(text) {
        this.clearTimers()
        this.bar.style.display = 'none'
        this.setLabel(text)
    }

    /** Réinitialise et masque la barre. */
    stop() {
        this.clearTimers()
        this.noteText = ''
        this.bar.classList.remove('indeterminate')
        this.fill.style.width = ''
        this.bar.style.display = 'none'
    }
}

class Home {
    static id = "home";
    /**
     * Initialise l'accueil : actualités, sélecteur d'instance, création, éditeur et lancement.
     * @param {object} config Configuration de l'API
     */
    async init(config) {
        this.config = config;
        this.db = new database();
        this.offline = !!config.offline;
        this.playing = false;
        this.instances = { official: [], locals: [], all: [] };
        this.gamePath = await getGamePath(config);
        this.progress = new LaunchProgress(
            document.querySelector('.progress-bar'),
            document.querySelector('.info-starting-game-text')
        );

        this.news()
        this.socialLick()
        this.bindInstanceUI()
        this.bindCreateUI()
        this.editor = new InstanceEditor(this)
        // Un fichier lâché hors d'une zone prévue ne doit pas ouvrir le fichier dans la fenêtre.
        document.addEventListener('dragover', e => e.preventDefault())
        document.addEventListener('drop', e => e.preventDefault())
        document.querySelector('.settings-btn').addEventListener('click', () => changePanel('settings'))
        window.addEventListener('venstone:account-changed', () => this.refreshInstances())

        await this.refreshInstances()
    }

    /* ------------------------------------------------------------------ */
    /* News                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * Crée le bloc HTML d'une actualité.
     * @returns {HTMLElement}
     */
    newsBlock(title, content, date, author) {
        let blockNews = document.createElement('div');
        blockNews.classList.add('news-block');
        blockNews.innerHTML = `
            <div class="news-header">
                <div class="header-text">
                    <div class="title">${title}</div>
                </div>
                <div class="date">
                    <div class="day">${date.day}</div>
                    <div class="month">${date.month}</div>
                </div>
            </div>
            <div class="news-content">
                <div class="bbWrapper">
                    <p>${content}</p>
                    ${author ? `<p class="news-author">${author}</p>` : ''}
                </div>
            </div>`
        return blockNews
    }

    /** Affiche les actualités (ou un message hors-ligne). */
    async news() {
        let newsElement = document.querySelector('.news-list');
        let news = await config.getNews().then(res => res).catch(() => false);
        let today = this.getdate(Date.now())

        if (news === false) {
            newsElement.appendChild(this.newsBlock(
                'Mode hors-ligne',
                'Impossible de contacter le serveur des news.</br>Vous pouvez tout de même jouer aux instances déjà installées.',
                today
            ));
            return
        }

        if (!news.length) {
            newsElement.appendChild(this.newsBlock(
                "Aucune news n'est actuellement disponible.",
                'Vous pourrez suivre ici toutes les news relatives au serveur.',
                today
            ));
            return
        }

        for (let News of news) {
            newsElement.appendChild(this.newsBlock(
                News.title,
                String(News.content || '').replace(/\n/g, '</br>'),
                this.getdate(News.publish_date),
                News.author
            ));
        }
    }

    /** Clic sur la tête du joueur : ouvre la page de changement de skin. */
    socialLick() {
        document.querySelector('.player-head').addEventListener('click', () => {
            let pseudo = document.getElementById("player-username").textContent
            shell.openExternal(`https://venstone.xyz/skins/changeskin/?pseudo=${encodeURIComponent(pseudo)}`)
        })
    }

    /* ------------------------------------------------------------------ */
    /* Instances                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Configuration du joueur et compte sélectionné.
     * @returns {Promise<{configClient: object, auth: object|undefined}>}
     */
    async currentAuth() {
        let configClient = await this.db.readData('configClient')
        let auth = configClient?.account_selected ? await this.db.readData('accounts', configClient.account_selected) : undefined
        return { configClient, auth }
    }

    /**
     * Recharge les instances (officielles + locales), corrige la sélection si besoin et met à
     * jour la barre du bas, le sélecteur et le statut du serveur.
     * @returns {Promise<object|undefined>} Instance sélectionnée
     */
    async refreshInstances() {
        let { configClient, auth } = await this.currentAuth()
        this.instances = await getAllInstances(auth)

        let selected = await resolveInstanceSelection(configClient, auth)
        if (configClient && configClient.instance_selct !== selected) {
            configClient.instance_selct = selected
            await this.db.updateData('configClient', configClient)
        }

        let instance = this.instances.all.find(i => i.name === selected)
        this.renderBottomBar(instance)
        this.renderInstanceLists(selected)
        await this.updateStatus(instance)
        return instance
    }

    /**
     * Statut du serveur associé à l'instance (ou à la première instance officielle).
     * @param {object} [instance]
     */
    async updateStatus(instance) {
        let status = instance?.status || this.instances.official[0]?.status
        await setStatus(status, this.offline)
    }

    /**
     * Remplit l'icône d'une instance : logo Venstone, image personnalisée ou initiales sur sa couleur.
     * @param {object} instance
     * @param {HTMLElement} element
     */
    iconHTML(instance, element) {
        element.classList.remove('official-icon', 'custom-icon')
        element.style.background = ''
        element.innerHTML = ''
        if (!instance) {
            element.textContent = '?'
        } else if (instance.official) {
            element.classList.add('official-icon')
            element.innerHTML = '<img src="assets/images/icon.png"/>'
        } else {
            paintIcon(element, instance)
        }
    }

    /**
     * Met à jour le sélecteur d'instance de la barre du bas.
     * @param {object} [instance] Instance sélectionnée
     */
    renderBottomBar(instance) {
        let name = document.querySelector('.instance-picker-name')
        let meta = document.querySelector('.instance-picker-meta')
        let icon = document.querySelector('.instance-picker-icon')
        let playBTN = document.querySelector('.play-instance')
        let settingsBTN = document.querySelector('.instance-settings')

        this.currentInstance = instance || null
        settingsBTN.classList.toggle('disabled', !instance)
        settingsBTN.dataset.tip = !instance ? 'Aucune instance sélectionnée'
            : instance.official ? 'Créer une copie modifiable'
            : "Paramètres de l'instance"

        this.iconHTML(instance, icon)
        if (!instance) {
            name.textContent = 'Aucune instance'
            meta.textContent = this.offline ? 'Hors-ligne' : 'Créez-en une'
            playBTN.classList.add('disabled')
            return
        }

        name.textContent = instance.name
        let installed = isInstalled(this.gamePath, instance)
        meta.innerHTML = `${escapeHTML(loaderLabel(instance))} · ${escapeHTML(instance.loadder?.minecraft_version)}`
            + (this.offline && !installed ? ' · <span class="orange">non installée</span>' : '')
        playBTN.classList.toggle('disabled', this.offline && !installed)
    }

    /**
     * Instance officielle : propose d'en créer une copie personnelle modifiable, en prévenant
     * qu'elle ne recevra plus les mises à jour du serveur.
     * @param {object} official
     */
    async proposeClone(official) {
        if (!isInstalled(this.gamePath, official)) {
            return confirmDialog({
                title: "Instance pas encore installée",
                html: `Lancez <b>${escapeHTML(official.name)}</b> une première fois pour la télécharger, vous pourrez ensuite en créer une copie modifiable.`,
                confirmText: 'Compris',
                cancelText: 'Fermer',
                icon: 'i'
            })
        }

        // Nom proposé, libre : « Venstone 26.2 (perso) », « Venstone 26.2 (perso 2) »...
        let base = `${official.name} (perso`
        let suggestion = `${base})`
        for (let n = 2; (await validateName(suggestion, this.instances.official)).error && n < 50; n++) suggestion = `${base} ${n})`

        let created = null
        let { confirmed } = await confirmDialog({
            title: 'Créer une copie modifiable ?',
            icon: '!',
            html: `Les instances officielles sont gérées par Venstone et ne peuvent pas être modifiées.
                Vous pouvez créer une <b>copie personnelle</b> de <b>${escapeHTML(official.name)}</b> (mods, configs, packs et réglages) et la modifier librement.
                <div class="confirm-dialog-warning"><b>Attention :</b> la copie ne recevra plus les mises à jour automatiques de l'instance officielle.
                Si le serveur change de version ou de mods, elle risque de ne plus pouvoir s'y connecter, et ce sera à vous de la maintenir à jour.</div>
                Vos mondes, serveurs et captures restent partagés entre toutes les instances.<br><br><b>Nom de la copie</b>`,
            input: { value: suggestion, placeholder: 'Nom de la copie' },
            confirmText: 'Créer la copie',
            busyText: 'Copie en cours...',
            onConfirm: async value => {
                let check = await validateName(value, this.instances.official)
                if (check.error) return check.error
                created = await cloneOfficialInstance(official, check.name, this.gamePath)
                return null
            }
        })
        if (!confirmed || !created) return

        await this.refreshInstances()
        await this.selectInstance(created.name)
        this.editor.open(created)
    }

    /**
     * Crée la carte d'une instance pour le sélecteur.
     * @param {object} instance
     * @param {string} selected Nom de l'instance sélectionnée
     * @returns {HTMLElement}
     */
    instanceCard(instance, selected) {
        let installed = isInstalled(this.gamePath, instance)
        let unavailable = this.offline && !installed
        let card = document.createElement('div')
        card.className = `instance-card${instance.name === selected ? ' active-instance' : ''}${unavailable ? ' unavailable' : ''}`
        card.dataset.name = instance.name

        let state = ''
        if (instance.name === selected) state = `<div class="instance-card-state selected">${ICON_CHECK}</div>`
        else if (unavailable) state = `<div class="instance-card-state warn" title="Connexion requise pour l'installer">Hors-ligne</div>`
        else if (!installed && !fs.existsSync(instanceFolder(this.gamePath, instance))) state =`<div class="instance-card-state muted" title="Sera téléchargée au premier lancement">À installer</div>`

        let actions = instance.local ? `
            <div class="instance-card-actions">
                <div class="icon-btn instance-edit" title="Mods et paramètres de l'instance">${ICON_GEAR}</div>
            </div>` : ''

        card.innerHTML = `
            <div class="instance-icon instance-card-icon"></div>
            <div class="instance-card-body">
                <div class="instance-card-name">${escapeHTML(instance.name)}</div>
                <div class="instance-card-meta">
                    <span class="loader-badge loader-${escapeHTML(instance.loadder?.loadder_type || 'none')}">${escapeHTML(loaderLabel(instance))}</span>
                    <span>${escapeHTML(instance.loadder?.minecraft_version || '')}</span>
                </div>
            </div>
            ${state}
            ${actions}`
        this.iconHTML(instance, card.querySelector('.instance-card-icon'))
        return card
    }

    /**
     * Affiche les deux colonnes du sélecteur (officielles / personnelles).
     * @param {string} selected Nom de l'instance sélectionnée
     */
    renderInstanceLists(selected) {
        let officialList = document.querySelector('.instances-List')
        let localList = document.querySelector('.custom-instances-List')
        let count = document.querySelector('.custom-instances-count')
        let subtitle = document.querySelector('.instances-subtitle')
        let createBTN = document.querySelector('.create-custom-instance')

        officialList.innerHTML = ''
        localList.innerHTML = ''

        subtitle.innerHTML = this.offline
            ? '<span class="offline-pill">Hors-ligne</span> Seules les instances déjà installées peuvent être lancées.'
            : "Vos mondes, serveurs et captures d'écran sont partagés entre toutes les instances."

        if (!this.instances.official.length) {
            officialList.innerHTML = `<div class="instances-empty">${this.offline ? 'Instances officielles indisponibles hors-ligne.' : 'Aucune instance officielle disponible.'}</div>`
        }
        for (let instance of this.instances.official) officialList.appendChild(this.instanceCard(instance, selected))

        if (!this.instances.locals.length) {
            localList.innerHTML = '<div class="instances-empty">Vous n\'avez pas encore d\'instance personnelle.<br>Créez-en une avec la version et le loader de votre choix.</div>'
        }
        for (let instance of this.instances.locals) localList.appendChild(this.instanceCard(instance, selected))

        count.textContent = this.instances.locals.length
        createBTN.classList.toggle('disabled', this.offline)
        createBTN.title = this.offline ? 'Connexion internet requise' : ''
    }

    /**
     * Sélectionne une instance et l'enregistre dans la configuration.
     * @param {string} name
     * @param {{silent?: boolean}} [options] `silent` : n'enregistre que la sélection, sans rafraîchir l'affichage
     */
    async selectInstance(name, { silent = false } = {}) {
        let configClient = await this.db.readData('configClient')
        configClient.instance_selct = name
        await this.db.updateData('configClient', configClient)
        if (silent) return
        let instance = this.instances.all.find(i => i.name === name)
        this.renderBottomBar(instance)
        this.renderInstanceLists(name)
        this.updateStatus(instance)
    }

    /** Ouvre le sélecteur d'instance (liste rafraîchie). */
    async openInstancePicker() {
        this.openPopup('.instance-popup')
        await this.refreshInstances()
    }

    /**
     * Ouvre une fenêtre modale avec son animation.
     * @param {string} selector
     */
    openPopup(selector) {
        let element = document.querySelector(selector)
        element.style.display = 'flex'
        requestAnimationFrame(() => element.classList.add('open'))
    }

    /**
     * Ferme une fenêtre modale.
     * @param {string} selector
     */
    closePopup(selector) {
        let element = document.querySelector(selector)
        element.classList.remove('open')
        element.style.display = 'none'
    }

    /** Branche le sélecteur d'instance, le bouton Jouer et le bouton de création. */
    bindInstanceUI() {
        let instancePopup = document.querySelector('.instance-popup')

        document.querySelector('.instance-picker').addEventListener('click', () => {
            if (!this.playing) this.openInstancePicker()
        })

        // Bouton à gauche du sélecteur : ouvre directement l'édition de l'instance sélectionnée.
        document.querySelector('.instance-settings').addEventListener('click', () => {
            let instance = this.currentInstance
            if (!instance) return
            if (this.playing) return this.showError("Fermez le jeu avant de modifier l'instance.")
            if (instance.official) return this.proposeClone(instance)
            this.editor.open(instance)
        })

        document.querySelector('.play-instance').addEventListener('click', () => {
            if (!this.instances.all.length) return this.openPopup('.instance-popup')
            this.startGame()
        })

        instancePopup.querySelector('.close-popup').addEventListener('click', () => this.closePopup('.instance-popup'))
        instancePopup.addEventListener('mousedown', e => {
            if (e.target === instancePopup) this.closePopup('.instance-popup')
        })

        instancePopup.querySelector('.instances-columns').addEventListener('click', async e => {
            let card = e.target.closest('.instance-card')
            if (!card) return
            let name = card.dataset.name
            let instance = this.instances.all.find(i => i.name === name)
            if (!instance) return

            if (e.target.closest('.instance-edit')) {
                if (this.playing) return this.showError("Fermez le jeu avant de modifier l'instance.")
                this.closePopup('.instance-popup')
                return this.editor.open(instance)
            }
            if (card.classList.contains('unavailable')) return

            await this.selectInstance(name)
            setTimeout(() => this.closePopup('.instance-popup'), 120)
        })

        document.querySelector('.create-custom-instance').addEventListener('click', e => {
            if (e.currentTarget.classList.contains('disabled')) return
            this.closePopup('.instance-popup')
            this.openCreate()
        })

    }

    /* ------------------------------------------------------------------ */
    /* Création d'instance                                                 */
    /* ------------------------------------------------------------------ */

    /** Branche la fenêtre de création d'instance. */
    bindCreateUI() {
        let root = document.querySelector('.create-popup')
        this.createForm = new InstanceForm(root, {
            onChange: () => root.querySelector('.create-submit').classList.toggle('disabled', !this.createForm.ready())
        })
        let close = () => this.closePopup('.create-popup')
        root.querySelector('.create-close').addEventListener('click', close)
        root.querySelector('.create-back').addEventListener('click', () => { close(); this.openInstancePicker() })
        root.addEventListener('mousedown', e => { if (e.target === root) close() })
        root.querySelector('.create-name').addEventListener('keydown', e => { if (e.key === 'Enter') this.submitCreate() })
        root.querySelector('.create-submit').addEventListener('click', () => this.submitCreate())
    }

    /** Ouvre la fenêtre de création avec un formulaire vierge. */
    async openCreate() {
        this.createForm.reset({ color: INSTANCE_COLORS[Math.floor(Math.random() * INSTANCE_COLORS.length)] })
        this.openPopup('.create-popup')
        setTimeout(() => document.querySelector('.create-popup .create-name').focus(), 50)
        await this.createForm.fillMinecraftVersions()
    }

    /** Valide le formulaire, crée l'instance et la sélectionne. */
    async submitCreate() {
        let form = this.createForm
        let submit = document.querySelector('.create-popup .create-submit')
        if (submit.classList.contains('disabled') || this.creating) return
        let data = form.data()

        let check = await validateName(data.name, this.instances.official)
        if (check.error) return form.setError(check.error)
        data.name = check.name

        this.creating = true
        submit.classList.add('disabled')
        try {
            let instance = await createLocalInstance(data)
            await this.refreshInstances()
            await this.selectInstance(instance.name)
            this.closePopup('.create-popup')
        } catch (err) {
            console.error(err)
            form.setError(`Création impossible : ${err.message}`)
        } finally {
            this.creating = false
            form.update()
        }
    }

    /* ------------------------------------------------------------------ */
    /* Lancement                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Bascule la barre du bas entre « Jouer » et la progression du lancement.
     * @param {boolean} playing
     * @param {string} [text]
     */
    setPlayingUI(playing, text = 'Vérification...') {
        this.playing = playing
        document.querySelector('.play-group').style.display = playing ? 'none' : 'flex'
        document.querySelector('.info-starting-game').style.display = playing ? 'block' : 'none'
        if (playing) this.progress.indeterminate(text)
        else this.progress.stop()
    }

    /**
     * Affiche une erreur dans la popup globale.
     * @param {string} content HTML
     */
    showError(content) {
        new popup().openPopup({ title: 'Erreur', content, color: 'red', options: true })
    }

    /**
     * Lance l'instance sélectionnée : vérifie la connexion, installe Fabric API si besoin,
     * prépare les données partagées puis démarre le jeu (en ligne ou depuis le cache hors-ligne).
     */
    async startGame() {
        if (this.playing) return
        let { configClient, auth } = await this.currentAuth()
        let instance = this.instances.all.find(i => i.name == configClient?.instance_selct)

        if (!auth) return this.showError('Aucun compte sélectionné.')
        if (!instance) return this.openPopup('.instance-popup')

        this.setPlayingUI(true, 'Connexion...')
        let progress = this.progress

        let online = await hasInternet()
        if (!online && !isInstalled(this.gamePath, instance)) {
            this.setPlayingUI(false)
            return this.showError("Pas de connexion internet.<br>Cette instance n'a encore jamais été installée : connectez-vous une première fois pour la télécharger.")
        }

        if (online && instance.fabricApi) {
            progress.indeterminate('Installation de Fabric API...')
            await ensureFabricApi(this.gamePath, instance).catch(err => console.warn('[Fabric API]', err))
        }

        let instanceDir = instanceFolder(this.gamePath, instance)
        try {
            progress.indeterminate('Préparation des mondes partagés...')
            prepareSharedData(this.gamePath, instanceDir, instance)
        } catch (err) {
            console.error('[Shared] partage des mondes impossible :', err)
        }

        let launch = new OfflineLaunch({ cacheFile: launchCacheFile(this.gamePath, instance), offline: !online })
        let loaderType = instance.loadder?.loadder_type || 'none'
        // Arguments JVM saisis dans les paramètres (séparés par des espaces, guillemets acceptés).
        let userJvmArgs = (String(configClient.java_config.jvm_args || '').match(/"[^"]*"|\S+/g) || [])
            .map(arg => arg.replace(/^"(.*)"$/, '$1'))

        let opt = {
            url: instance.official ? instance.url : null,
            authenticator: auth,
            timeout: 10000,
            path: this.gamePath,
            instance: instance.name,
            version: instance.loadder.minecraft_version,
            detached: configClient.launcher_config.closeLauncher == "close-all" ? false : true,
            downloadFileMultiple: Number(configClient.launcher_config.download_multi) || 5,
            intelEnabledMac: configClient.launcher_config.intelEnabledMac,

            loader: {
                type: loaderType,
                build: String(instance.loadder.loadder_version || 'latest'),
                enable: loaderType != 'none'
            },

            verify: !!instance.verify,
            ignored: [...(instance.ignored || [])],

            java: {
                path: configClient.java_config.java_path,
            },

            JVM_ARGS: [...(instance.jvm_args || []), ...userJvmArgs],
            GAME_ARGS: [...(instance.game_args || []), ...(configClient.game_config.fullscreen ? ['--fullscreen'] : [])],

            screen: {
                width: configClient.game_config.screen_size.width,
                height: configClient.game_config.screen_size.height
            },

            memory: {
                min: `${configClient.java_config.java_memory.min * 1024}M`,
                max: `${configClient.java_config.java_memory.max * 1024}M`
            }
        }

        progress.indeterminate(online ? 'Vérification des fichiers...' : 'Lancement hors-ligne...')
        ipcRenderer.send('main-window-progress-load')

        let finished = false
        let reset = () => {
            if (finished) return
            finished = true
            try { finishSharedData(this.gamePath, instanceDir, instance) } catch (err) { console.error('[Shared]', err) }
            if (configClient.launcher_config.closeLauncher == 'close-launcher') ipcRenderer.send("main-window-show")
            ipcRenderer.send('main-window-progress-reset')
            this.setPlayingUI(false)
            new logger(pkg.name, '#7289da');
            let selected = this.instances.all.find(i => i.name === instance.name)
            this.renderBottomBar(selected)
            this.renderInstanceLists(instance.name)
        }

        launch.on('offline', () => progress.indeterminate('Lancement hors-ligne...'))

        launch.on('extract', extract => {
            ipcRenderer.send('main-window-progress-load')
            progress.indeterminate('Extraction...')
            console.log(extract);
        });

        launch.on('progress', (value, size) => {
            if (!size) return
            progress.set(value, size, 'Téléchargement')
            ipcRenderer.send('main-window-progress', { progress: value, size })
        });

        launch.on('check', (value, size) => {
            if (!size) return
            progress.set(value, size, 'Vérification')
            ipcRenderer.send('main-window-progress', { progress: value, size })
        });

        launch.on('estimated', (time) => {
            let hours = Math.floor(time / 3600);
            let minutes = Math.floor((time - hours * 3600) / 60);
            let seconds = Math.floor(time - hours * 3600 - minutes * 60);
            console.log(`${hours}h ${minutes}m ${seconds}s`);
        })

        launch.on('speed', (speed) => {
            console.log(`${(speed / 1067008).toFixed(2)} Mb/s`)
        })

        launch.on('patch', patch => {
            console.log(patch);
            ipcRenderer.send('main-window-progress-load')
            progress.indeterminate('Installation du mod loader...')
        });

        let started = false
        launch.on('data', (e) => {
            if (!started) {
                started = true
                progress.done('En jeu')
                if (configClient.launcher_config.closeLauncher == 'close-launcher') ipcRenderer.send("main-window-hide")
                new logger('Minecraft', '#36b030');
                ipcRenderer.send('main-window-progress-reset')
            }
            console.log(e);
        })

        launch.on('close', () => {
            reset()
            console.log('Close');
        });

        launch.on('error', err => {
            console.error(err);
            // Erreur de téléchargement d'un fichier : la lib continue, on ne bloque pas l'UI.
            if (err instanceof Error && !started) {
                progress.note('erreurs réseau, nouvel essai au prochain lancement')
                return
            }
            let message = err?.error === true ? err.message : (err?.error || err?.message || 'Erreur inconnue')
            this.showError(typeof message === 'string' ? message : escapeHTML(JSON.stringify(message)))
            reset()
        });

        launch.Launch(opt);
    }

    /**
     * Date d'une actualité (jour + mois en toutes lettres).
     * @returns {{year: number, month: string, day: number}}
     */
    getdate(e) {
        let date = new Date(e)
        if (isNaN(date)) date = new Date()
        let allMonth = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
        return { year: date.getFullYear(), month: allMonth[date.getMonth()], day: date.getDate() }
    }
}
export default Home;
