/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */
import { config, database, logger, changePanel, setStatus, pkg, popup } from '../utils.js'
import OfflineLaunch from '../utils/launch.js'
import { prepareSharedData, finishSharedData } from '../utils/shared.js'
import {
    LOADERS, INSTANCE_COLORS, getGamePath, getAllInstances, resolveInstanceSelection, isInstalled,
    launchCacheFile, instanceFolder, validateName, createLocalInstance, deleteLocalInstance,
    getMinecraftVersions, getLoaderVersions, getFabricApiVersions, ensureFabricApi, hasInternet
} from '../utils/instances.js'

const { shell, ipcRenderer } = require('electron')
const fs = require('fs')

const ICON_FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.38a1.5 1.5 0 0 1 1.06.44L11.5 7h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>'
const ICON_TRASH = '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z"/></svg>'
const ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/></svg>'

function escapeHTML(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function initials(name) {
    let words = String(name).trim().split(/\s+/).filter(Boolean)
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
    return String(name).slice(0, 2).toUpperCase()
}

function loaderLabel(instance) {
    let type = instance?.loadder?.loadder_type || 'none'
    let label = LOADERS[type]?.label || type
    let build = instance?.loadder?.loadder_version
    if (type === 'none' || !build || build === 'latest') return label
    return `${label} ${String(build).replace(`${instance.loadder.minecraft_version}-`, '')}`
}

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

    setLabel(text) {
        this.label.innerHTML = this.noteText ? `${text}<div class="progress-note">${this.noteText}</div>` : text
    }

    clearTimers() {
        clearInterval(this.timer)
        clearTimeout(this.idle)
    }

    indeterminate(text) {
        this.clearTimers()
        this.bar.style.display = ''
        this.bar.classList.add('indeterminate')
        this.fill.style.width = ''
        this.setLabel(text)
    }

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

    note(text) {
        this.noteText = text
    }

    done(text) {
        this.clearTimers()
        this.bar.style.display = 'none'
        this.setLabel(text)
    }

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
        document.querySelector('.settings-btn').addEventListener('click', () => changePanel('settings'))
        window.addEventListener('venstone:account-changed', () => this.refreshInstances())

        await this.refreshInstances()
    }

    /* ------------------------------------------------------------------ */
    /* News                                                                */
    /* ------------------------------------------------------------------ */

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

    socialLick() {
        document.querySelector('.player-options').addEventListener('click', () => {
            let pseudo = document.getElementById("player-username").textContent
            shell.openExternal(`https://venstone.xyz/skins/changeskin/?pseudo=${encodeURIComponent(pseudo)}`)
        })
    }

    /* ------------------------------------------------------------------ */
    /* Instances                                                           */
    /* ------------------------------------------------------------------ */

    async currentAuth() {
        let configClient = await this.db.readData('configClient')
        let auth = configClient?.account_selected ? await this.db.readData('accounts', configClient.account_selected) : undefined
        return { configClient, auth }
    }

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

    async updateStatus(instance) {
        let status = instance?.status || this.instances.official[0]?.status
        await setStatus(status, this.offline)
    }

    iconHTML(instance, element) {
        element.classList.remove('official-icon')
        element.style.background = ''
        element.innerHTML = ''
        if (!instance) {
            element.textContent = '?'
        } else if (instance.official) {
            element.classList.add('official-icon')
            element.innerHTML = '<img src="assets/images/icon.png"/>'
        } else {
            element.style.background = instance.color || INSTANCE_COLORS[0]
            element.textContent = initials(instance.name)
        }
    }

    renderBottomBar(instance) {
        let name = document.querySelector('.instance-picker-name')
        let meta = document.querySelector('.instance-picker-meta')
        let icon = document.querySelector('.instance-picker-icon')
        let playBTN = document.querySelector('.play-instance')

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
                <div class="icon-btn instance-open-folder" title="Ouvrir le dossier">${ICON_FOLDER}</div>
                <div class="icon-btn danger instance-delete" title="Supprimer">${ICON_TRASH}</div>
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

    async selectInstance(name) {
        let configClient = await this.db.readData('configClient')
        configClient.instance_selct = name
        await this.db.updateData('configClient', configClient)
        let instance = this.instances.all.find(i => i.name === name)
        this.renderBottomBar(instance)
        this.renderInstanceLists(name)
        this.updateStatus(instance)
    }

    openPopup(selector) {
        let element = document.querySelector(selector)
        element.style.display = 'flex'
        requestAnimationFrame(() => element.classList.add('open'))
    }

    closePopup(selector) {
        let element = document.querySelector(selector)
        element.classList.remove('open')
        element.style.display = 'none'
    }

    bindInstanceUI() {
        let instancePopup = document.querySelector('.instance-popup')

        document.querySelector('.instance-picker').addEventListener('click', async () => {
            if (this.playing) return
            this.openPopup('.instance-popup')
            await this.refreshInstances()
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

            if (e.target.closest('.instance-open-folder')) {
                let folder = instanceFolder(this.gamePath, instance)
                fs.mkdirSync(folder, { recursive: true })
                return shell.openPath(folder)
            }
            if (e.target.closest('.instance-delete')) return this.askDelete(instance)
            if (card.classList.contains('unavailable')) return

            await this.selectInstance(name)
            setTimeout(() => this.closePopup('.instance-popup'), 120)
        })

        document.querySelector('.create-custom-instance').addEventListener('click', e => {
            if (e.currentTarget.classList.contains('disabled')) return
            this.closePopup('.instance-popup')
            this.openCreate()
        })

        // Confirmation de suppression
        let confirm = document.querySelector('.confirm-delete')
        confirm.querySelector('.confirm-delete-cancel').addEventListener('click', () => confirm.style.display = 'none')
        confirm.querySelector('.confirm-delete-ok').addEventListener('click', async () => {
            let instance = this.pendingDelete
            confirm.style.display = 'none'
            if (!instance) return
            try {
                await deleteLocalInstance(instance.name, this.gamePath, confirm.querySelector('.confirm-delete-files').checked)
            } catch (err) {
                console.error(err)
                new popup().openPopup({ title: 'Erreur', content: `Suppression impossible : ${escapeHTML(err.message)}`, color: 'red', options: true })
            }
            this.pendingDelete = null
            await this.refreshInstances()
        })
    }

    askDelete(instance) {
        this.pendingDelete = instance
        let confirm = document.querySelector('.confirm-delete')
        confirm.querySelector('.confirm-delete-text').innerHTML = `L'instance <b>${escapeHTML(instance.name)}</b> sera retirée du launcher.`
        confirm.querySelector('.confirm-delete-files').checked = false
        confirm.style.display = 'flex'
    }

    /* ------------------------------------------------------------------ */
    /* Création d'instance                                                 */
    /* ------------------------------------------------------------------ */

    bindCreateUI() {
        let root = document.querySelector('.create-popup')
        this.create = {
            root,
            name: root.querySelector('.create-name'),
            swatches: root.querySelector('.color-swatches'),
            mcVersion: root.querySelector('.create-mc-version'),
            snapshots: root.querySelector('.create-snapshots'),
            loader: root.querySelector('.create-loader'),
            loaderField: root.querySelector('.create-loader-field'),
            loaderVersion: root.querySelector('.create-loader-version'),
            apiField: root.querySelector('.create-fabricapi-field'),
            apiEnabled: root.querySelector('.create-fabricapi-enabled'),
            apiVersion: root.querySelector('.create-fabricapi-version'),
            error: root.querySelector('.create-error'),
            submit: root.querySelector('.create-submit'),
            state: { loader: 'none', color: INSTANCE_COLORS[0], loaderVersions: [], apiVersions: [] },
            requestId: 0
        }
        let c = this.create

        c.swatches.innerHTML = INSTANCE_COLORS.map(color => `<div class="swatch" data-color="${color}" style="background:${color}"></div>`).join('')
        c.swatches.addEventListener('click', e => {
            let swatch = e.target.closest('.swatch')
            if (!swatch) return
            c.state.color = swatch.dataset.color
            this.updateCreateUI()
        })

        c.loader.addEventListener('click', e => {
            let segment = e.target.closest('.segment')
            if (!segment || segment.classList.contains('active')) return
            c.state.loader = segment.dataset.loader
            this.updateCreateUI()
            this.loadLoaderVersions()
        })

        c.name.addEventListener('input', () => { c.error.textContent = ''; this.updateCreateUI() })
        c.snapshots.addEventListener('change', () => this.fillMinecraftVersions())
        c.mcVersion.addEventListener('change', () => { this.updateCreateUI(); this.loadLoaderVersions() })
        c.loaderVersion.addEventListener('change', () => this.updateCreateUI())
        c.apiVersion.addEventListener('change', () => this.updateCreateUI())
        c.apiEnabled.addEventListener('change', () => this.updateCreateUI())

        let close = () => this.closePopup('.create-popup')
        root.querySelector('.create-close').addEventListener('click', close)
        root.querySelector('.create-back').addEventListener('click', () => { close(); this.openPopup('.instance-popup') })
        root.addEventListener('mousedown', e => { if (e.target === root) close() })
        c.name.addEventListener('keydown', e => { if (e.key === 'Enter') this.submitCreate() })
        c.submit.addEventListener('click', () => this.submitCreate())
    }

    async openCreate() {
        let c = this.create
        c.name.value = ''
        c.error.textContent = ''
        c.state.loader = 'none'
        c.state.color = INSTANCE_COLORS[Math.floor(Math.random() * INSTANCE_COLORS.length)]
        c.snapshots.checked = false
        c.apiEnabled.checked = true
        this.openPopup('.create-popup')
        this.updateCreateUI()
        setTimeout(() => c.name.focus(), 50)
        await this.fillMinecraftVersions()
    }

    setSelectLoading(select, text) {
        select.innerHTML = `<option value="">${text}</option>`
        select.disabled = true
    }

    async fillMinecraftVersions() {
        let c = this.create
        let previous = c.mcVersion.value
        this.setSelectLoading(c.mcVersion, 'Chargement des versions...')
        try {
            let { versions, latest } = await getMinecraftVersions()
            let list = versions.filter(v => v.type === 'release' || (c.snapshots.checked && v.type === 'snapshot'))
            c.mcVersion.innerHTML = list.map(v => {
                let tag = v.id === latest.release ? ' (dernière)' : v.type === 'snapshot' ? ' (snapshot)' : ''
                return `<option value="${escapeHTML(v.id)}">${escapeHTML(v.id)}${tag}</option>`
            }).join('')
            c.mcVersion.disabled = false
            c.mcVersion.value = list.some(v => v.id === previous) ? previous : latest.release
        } catch (err) {
            console.error(err)
            this.setSelectLoading(c.mcVersion, 'Impossible de charger les versions')
            c.error.textContent = 'Connexion aux serveurs Mojang impossible.'
        }
        this.updateCreateUI()
        await this.loadLoaderVersions()
    }

    async loadLoaderVersions() {
        let c = this.create
        let loader = c.state.loader
        let mc = c.mcVersion.value
        let requestId = ++c.requestId
        c.state.loaderVersions = []
        c.state.apiVersions = []

        if (loader === 'none' || !mc) {
            this.updateCreateUI()
            return
        }

        this.setSelectLoading(c.loaderVersion, 'Chargement...')
        let withApi = loader === 'fabric' || loader === 'quilt'
        if (withApi) this.setSelectLoading(c.apiVersion, 'Chargement...')
        this.updateCreateUI()

        let [loaders, apis] = await Promise.all([
            getLoaderVersions(loader, mc).catch(err => { console.error(err); return null }),
            withApi ? getFabricApiVersions(mc).catch(err => { console.error(err); return null }) : Promise.resolve([])
        ])
        if (requestId !== c.requestId) return // une autre requête a pris le relais

        if (loaders === null) {
            this.setSelectLoading(c.loaderVersion, 'Erreur de chargement')
        } else if (!loaders.length) {
            this.setSelectLoading(c.loaderVersion, `${LOADERS[loader].label} n'est pas disponible pour ${mc}`)
        } else {
            c.state.loaderVersions = loaders
            let recommended = loaders.find(l => l.stable) || loaders[0]
            c.loaderVersion.innerHTML = loaders.map(l => {
                let tag = l === recommended ? ' (recommandée)' : !l.stable ? ' (bêta)' : ''
                return `<option value="${escapeHTML(l.version)}">${escapeHTML(l.label || l.version)}${tag}</option>`
            }).join('')
            c.loaderVersion.value = recommended.version
            c.loaderVersion.disabled = false
        }

        if (withApi) {
            if (apis === null) this.setSelectLoading(c.apiVersion, 'Erreur de chargement')
            else if (!apis.length) this.setSelectLoading(c.apiVersion, `Aucune version pour ${mc}`)
            else {
                c.state.apiVersions = apis
                c.apiVersion.innerHTML = apis.map((v, i) => `<option value="${i}">${escapeHTML(v.version)}${i === 0 ? ' (dernière)' : ''}</option>`).join('')
                c.apiVersion.value = '0'
                c.apiVersion.disabled = false
            }
        }
        this.updateCreateUI()
    }

    createFormData() {
        let c = this.create
        let loader = c.state.loader
        let withApi = (loader === 'fabric' || loader === 'quilt') && c.apiEnabled.checked
        let api = withApi ? c.state.apiVersions[Number(c.apiVersion.value)] : null
        return {
            name: c.name.value.trim(),
            color: c.state.color,
            minecraft_version: c.mcVersion.value,
            loadder_type: loader,
            loadder_version: loader === 'none' ? 'latest' : c.loaderVersion.value,
            fabricApi: api ? { version: api.version, url: api.url, filename: api.filename, sha1: api.sha1 } : null
        }
    }

    createFormReady() {
        let c = this.create
        let data = this.createFormData()
        if (!data.name || !data.minecraft_version || c.mcVersion.disabled) return false
        if (data.loadder_type !== 'none' && (!data.loadder_version || c.loaderVersion.disabled)) return false
        return true
    }

    updateCreateUI() {
        let c = this.create
        let { loader, color } = c.state
        let data = this.createFormData()

        c.loader.querySelectorAll('.segment').forEach(s => s.classList.toggle('active', s.dataset.loader === loader))
        c.swatches.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s.dataset.color === color))
        c.loaderField.style.display = loader === 'none' ? 'none' : ''
        c.apiField.style.display = loader === 'fabric' || loader === 'quilt' ? '' : 'none'
        c.apiVersion.classList.toggle('dimmed', !c.apiEnabled.checked)

        // Aperçu
        let previewName = data.name || 'Mon instance'
        let icon = c.root.querySelector('.preview-icon')
        icon.style.background = color
        icon.textContent = initials(previewName)
        c.root.querySelector('.preview-name').textContent = previewName

        let chips = [`<span class="loader-badge loader-${loader}">${escapeHTML(loaderLabel({ loadder: { loadder_type: loader, loadder_version: loader === 'none' ? null : c.loaderVersion.disabled ? null : data.loadder_version, minecraft_version: data.minecraft_version } }))}</span>`]
        if (data.minecraft_version) chips.push(`<span class="chip">Minecraft ${escapeHTML(data.minecraft_version)}</span>`)
        if (data.fabricApi) chips.push(`<span class="chip">Fabric API ${escapeHTML(data.fabricApi.version.split('+')[0])}</span>`)
        c.root.querySelector('.preview-chips').innerHTML = chips.join('')

        c.submit.classList.toggle('disabled', !this.createFormReady())
    }

    async submitCreate() {
        let c = this.create
        if (c.submit.classList.contains('disabled') || c.busy) return
        let data = this.createFormData()

        let check = await validateName(data.name, this.instances.official)
        if (check.error) {
            c.error.textContent = check.error
            return
        }
        data.name = check.name

        c.busy = true
        c.submit.classList.add('disabled')
        try {
            let instance = await createLocalInstance(data)
            await this.refreshInstances()
            await this.selectInstance(instance.name)
            this.closePopup('.create-popup')
        } catch (err) {
            console.error(err)
            c.error.textContent = `Création impossible : ${err.message}`
        } finally {
            c.busy = false
            this.updateCreateUI()
        }
    }

    /* ------------------------------------------------------------------ */
    /* Lancement                                                           */
    /* ------------------------------------------------------------------ */

    setPlayingUI(playing, text = 'Vérification...') {
        this.playing = playing
        document.querySelector('.play-group').style.display = playing ? 'none' : 'flex'
        document.querySelector('.info-starting-game').style.display = playing ? 'block' : 'none'
        if (playing) this.progress.indeterminate(text)
        else this.progress.stop()
    }

    showError(content) {
        new popup().openPopup({ title: 'Erreur', content, color: 'red', options: true })
    }

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

    getdate(e) {
        let date = new Date(e)
        if (isNaN(date)) date = new Date()
        let allMonth = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
        return { year: date.getFullYear(), month: allMonth[date.getMonth()], day: date.getDate() }
    }
}
export default Home;
