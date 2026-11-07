/**
 * Fenêtre d'édition d'une instance personnelle :
 *  - onglets Mods, Packs de textures et Shaders : liste avec activation, suppression, import
 *    (bouton ou glisser-déposer) et vérification de compatibilité avant ajout ;
 *  - onglet Paramètres : nom, couleur, version, loader, Fabric API, suppression.
 */

import InstanceForm, { escapeHTML, initials, loaderLabel } from '../utils/instanceForm.js'
import { confirmDialog, reasonsList } from '../utils/dialog.js'
import { listMods, setModEnabled, importMod, deleteMod, readModInfo, checkCompatibility, modsFolder } from '../utils/mods.js'
import { instanceFolder, validateName, updateLocalInstance, deleteLocalInstance } from '../utils/instances.js'
import {
    PACK_FOLDERS, listPacks, importPack, deletePack, readResourcePack, readShaderPack, packCompatibility, gameResourceFormat,
    formatRangeLabel, activeResourcePacks, setResourcePackEnabled, shaderLoader, activeShaderPack, setActiveShaderPack
} from '../utils/packs.js'

const { shell } = require('electron')
const fs = require('fs')
const path = require('path')

const ICON_TRASH = '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z"/></svg>'
const ICON_PUZZLE = '<svg viewBox="0 0 24 24"><path d="M10 3a2 2 0 0 1 2 2v1h4a1 1 0 0 1 1 1v4h1a2 2 0 1 1 0 4h-1v4a1 1 0 0 1-1 1h-4v-1a2 2 0 1 0-4 0v1H4a1 1 0 0 1-1-1v-4h1a2 2 0 1 0 0-4H3V7a1 1 0 0 1 1-1h4V5a2 2 0 0 1 2-2z"/></svg>'
const ICON_IMAGE = '<svg viewBox="0 0 24 24"><path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v10.6l4-4 3 3 4-5 3 3.8V6zm4 1.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg>'
const ICON_SUN = '<svg viewBox="0 0 24 24"><path d="M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10zM11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.2 2.8l2.1 2.1-1.4 1.4-2.1-2.1zm14.9 14.9 2.1 2.1-1.4 1.4-2.1-2.1zM2.8 19.8l2.1-2.1 1.4 1.4-2.1 2.1zM17.7 4.9l2.1-2.1 1.4 1.4-2.1 2.1z"/></svg>'

/** Textes propres à chaque type de pack. */
const PACK_TEXT = {
    resourcepacks: { one: 'pack de textures', icon: ICON_IMAGE, empty: 'Aucun pack de textures' },
    shaderpacks: { one: 'pack de shaders', icon: ICON_SUN, empty: 'Aucun pack de shaders' }
}

export default class InstanceEditor {
    constructor(home) {
        this.home = home
        this.root = document.querySelector('.edit-popup')
        this.instance = null
        this.mods = []
        this.packs = { resourcepacks: [], shaderpacks: [] }
        this.formLoaded = false
        this.form = new InstanceForm(this.root.querySelector('.edit-general'), { onChange: () => this.updateSaveState() })
        this.bind()
    }

    get dir() {
        return instanceFolder(this.home.gamePath, this.instance)
    }

    /** Version de Minecraft de l'instance. */
    get mcVersion() {
        return this.instance.loadder?.minecraft_version
    }

    /** L'instance a-t-elle un mod loader ? */
    get modded() {
        return (this.instance.loadder?.loadder_type || 'none') !== 'none'
    }

    /** Raccourci querySelector limité à la fenêtre d'édition. */
    q(selector) {
        return this.root.querySelector(selector)
    }

    /** Onglet de contenu d'un type donné. */
    pane(kind) {
        return this.q(`.content-pane[data-kind="${kind}"]`)
    }

    /** Branche les onglets, les listes de contenu et les paramètres. */
    bind() {
        let close = () => this.close()
        this.q('.edit-close').addEventListener('click', close)
        this.q('.edit-back').addEventListener('click', () => { this.close(); this.home.openInstancePicker() })
        this.root.addEventListener('mousedown', e => { if (e.target === this.root) close() })

        this.q('.edit-tabs').addEventListener('click', e => {
            let btn = e.target.closest('.edit-tab-btn')
            if (btn) this.showTab(btn.dataset.tab)
        })

        this.root.querySelectorAll('.content-pane').forEach(pane => this.bindPane(pane))

        // --- Paramètres ---
        this.q('.edit-save').addEventListener('click', () => this.save())
        this.q('.edit-delete').addEventListener('click', () => this.deleteInstance())
    }

    /**
     * Branche un onglet de contenu (mods, packs de textures ou shaders) : recherche, dossier,
     * import par bouton ou glisser-déposer, activation et suppression.
     * @param {HTMLElement} pane
     */
    bindPane(pane) {
        let kind = pane.dataset.kind
        let q = selector => pane.querySelector(selector)

        q('.pane-search').addEventListener('input', () => this.render(kind))
        q('.pane-folder').addEventListener('click', () => {
            let dir = this.folderOf(kind)
            fs.mkdirSync(dir, { recursive: true })
            shell.openPath(dir)
        })
        let fileInput = q('.pane-file')
        q('.pane-import').addEventListener('click', () => {
            fileInput.value = ''
            fileInput.click()
        })
        fileInput.addEventListener('change', () => {
            let files = [...fileInput.files].map(f => f.path).filter(Boolean)
            if (files.length) this.importFiles(kind, files)
        })

        let itemOf = el => {
            let row = el.closest('.mod-row')
            return row && this.itemsOf(kind).find(m => m.file === row.dataset.file)
        }
        q('.pane-list').addEventListener('click', e => {
            let item = itemOf(e.target)
            if (item && e.target.closest('.mod-delete')) this.removeItem(kind, item)
        })
        q('.pane-list').addEventListener('change', e => {
            let toggle = e.target.closest('.mod-toggle')
            let item = toggle && itemOf(toggle)
            if (item) this.toggleItem(kind, item, toggle.checked)
        })

        // Glisser-déposer de fichiers (ou de dossiers pour les packs)
        let depth = 0
        pane.addEventListener('dragenter', e => {
            if (!this.hasFiles(e)) return
            e.preventDefault()
            depth++
            pane.classList.add('dragging')
        })
        pane.addEventListener('dragover', e => { if (this.hasFiles(e)) e.preventDefault() })
        pane.addEventListener('dragleave', () => {
            depth = Math.max(0, depth - 1)
            if (!depth) pane.classList.remove('dragging')
        })
        pane.addEventListener('drop', e => {
            e.preventDefault()
            depth = 0
            pane.classList.remove('dragging')
            let files = [...(e.dataTransfer?.files || [])].map(f => f.path).filter(Boolean)
            if (files.length) this.importFiles(kind, files)
        })
    }

    /** L'élément glissé contient-il des fichiers ? */
    hasFiles(e) {
        return [...(e.dataTransfer?.types || [])].includes('Files')
    }

    /** Dossier d'un type de contenu dans l'instance. */
    folderOf(kind) {
        return kind === 'mods' ? modsFolder(this.dir) : `${this.dir}/${PACK_FOLDERS[kind]}`
    }

    /** Éléments affichés dans un onglet de contenu. */
    itemsOf(kind) {
        return kind === 'mods' ? this.mods : this.packs[kind]
    }

    /** Affiche un onglet de contenu (après une recherche par exemple). */
    render(kind) {
        return kind === 'mods' ? this.renderMods() : this.renderPacks(kind)
    }

    /** Active / désactive un élément. */
    toggleItem(kind, item, enabled) {
        return kind === 'mods' ? this.toggleMod(item, enabled) : this.togglePack(kind, item, enabled)
    }

    /** Supprime un élément après confirmation. */
    removeItem(kind, item) {
        return kind === 'mods' ? this.removeMod(item) : this.removePack(kind, item)
    }

    /** Importe des fichiers dans un onglet de contenu. */
    importFiles(kind, files) {
        return kind === 'mods' ? this.importMods(files) : this.importPacks(kind, files)
    }

    /**
     * Ouvre l'éditeur pour une instance.
     * @param {object} instance Instance locale
     * @param {"mods"|"resourcepacks"|"shaderpacks"|"general"} [tab]
     */
    open(instance, tab = 'mods') {
        this.instance = instance
        this.formLoaded = false
        this.root.querySelectorAll('.pane-search').forEach(input => input.value = '')
        this.renderHeader()
        this.form.reset(instance.loadder ? {
            name: instance.name,
            color: instance.color,
            minecraft_version: instance.loadder.minecraft_version,
            loadder_type: instance.loadder.loadder_type || 'none',
            loadder_version: instance.loadder.loadder_version,
            fabricApi: instance.fabricApi || null
        } : {})
        this.refreshAll()
        this.showTab(tab)
        this.home.openPopup('.edit-popup')
    }

    /** Ferme l'éditeur. */
    close() {
        this.home.closePopup('.edit-popup')
    }

    /** Relit tous les onglets de contenu (les shaders ne sont proposés qu'aux instances moddées). */
    refreshAll() {
        this.q('.edit-tab-shaders').classList.toggle('hidden', !this.modded)
        this.refreshMods()
        this.refreshPacks('resourcepacks')
    }

    /**
     * Affiche un onglet ; les versions ne sont chargées qu'à la première ouverture des paramètres.
     * @param {"mods"|"resourcepacks"|"shaderpacks"|"general"} tab
     */
    showTab(tab) {
        if (tab === 'shaderpacks' && !this.modded) tab = 'mods'
        this.root.querySelectorAll('.edit-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab))
        this.root.querySelectorAll('.edit-pane').forEach(p => p.classList.toggle('active', p.classList.contains(`edit-pane-${tab}`)))
        if (tab === 'general' && !this.formLoaded) {
            this.formLoaded = true
            this.form.fillMinecraftVersions()
        }
    }

    /** En-tête : icône, nom, loader et version. */
    renderHeader() {
        let i = this.instance
        this.home.iconHTML(i, this.q('.edit-icon'))
        this.q('.edit-title').textContent = i.name
        this.q('.edit-subtitle').innerHTML = `<span class="loader-badge loader-${escapeHTML(i.loadder?.loadder_type || 'none')}">${escapeHTML(loaderLabel(i))}</span> Minecraft ${escapeHTML(i.loadder?.minecraft_version)}`
    }

    /**
     * Ligne d'une liste de contenu.
     * @param {{file: string, enabled: boolean, icon: string|null, letter: string, name: string, version?: string, badge?: string, meta: string, title?: string, toggleDisabled?: boolean, toggleTitle?: string}} row
     */
    rowHTML(row) {
        let icon = row.icon
            ? `<div class="mod-icon" style="background-image:url('${row.icon}')"></div>`
            : `<div class="mod-icon mod-icon-letter">${escapeHTML(initials(row.letter))}</div>`
        return `
            <div class="mod-row${row.enabled || row.noDim ? '' : ' disabled'}" data-file="${escapeHTML(row.file)}">
                ${icon}
                <div class="mod-body">
                    <div class="mod-name">${escapeHTML(row.name)} <span class="mod-version">${escapeHTML(row.version || '')}</span> ${row.badge || ''}</div>
                    <div class="mod-meta" title="${escapeHTML(row.title || row.meta)}">${escapeHTML(row.meta)}</div>
                </div>
                <label class="switch${row.toggleDisabled ? ' locked' : ''}" title="${escapeHTML(row.toggleTitle || (row.enabled ? 'Désactiver' : 'Activer'))}"><input type="checkbox" class="mod-toggle"${row.enabled ? ' checked' : ''}${row.toggleDisabled ? ' disabled' : ''}/><span></span></label>
                <div class="icon-btn danger mod-delete" title="Supprimer">${ICON_TRASH}</div>
            </div>`
    }

    /** Recherche saisie dans un onglet. */
    searchOf(kind) {
        return this.pane(kind).querySelector('.pane-search').value.trim().toLowerCase()
    }

    /* ------------------------------------------------------------------ */
    /* Mods                                                                */
    /* ------------------------------------------------------------------ */

    /** Relit le dossier des mods et recalcule leur compatibilité. */
    refreshMods() {
        try {
            this.mods = listMods(this.dir)
        } catch (err) {
            console.error('[Mods]', err)
            this.mods = []
        }
        for (let mod of this.mods) {
            mod.compat = mod.enabled ? checkCompatibility(mod.info, this.instance, this.mods) : null
        }
        this.renderMods()
        // Les shaders dépendent des mods installés (Iris, Oculus, OptiFine).
        if (this.modded) this.refreshPacks('shaderpacks')
    }

    /** Affiche la liste des mods (filtrée par la recherche) avec leurs badges. */
    renderMods() {
        let pane = this.pane('mods')
        let list = pane.querySelector('.pane-list')
        let search = this.searchOf('mods')
        let enabled = this.mods.filter(m => m.enabled).length
        let problems = this.mods.filter(m => m.compat && (m.compat.errors.length || m.compat.warnings.length)).length

        this.q('[data-count="mods"]').textContent = this.mods.length
        pane.querySelector('.pane-summary').innerHTML = this.mods.length
            ? `${enabled} actif${enabled > 1 ? 's' : ''} sur ${this.mods.length}${problems ? ` · <span class="orange">${problems} à vérifier</span>` : ''}`
            : ''

        if (!this.modded) {
            list.innerHTML = `<div class="mods-empty">${ICON_PUZZLE}<b>Instance Vanilla</b>Les mods nécessitent un mod loader. Choisissez Fabric, Quilt, Forge ou NeoForge dans <a class="mods-goto-general">Paramètres de l'instance</a>.</div>`
            list.querySelector('.mods-goto-general').onclick = () => this.showTab('general')
            return
        }
        if (!this.mods.length) {
            list.innerHTML = `<div class="mods-empty">${ICON_PUZZLE}<b>Aucun mod installé</b>Cliquez sur « Importer des mods » ou glissez vos fichiers .jar ici.<br>La compatibilité est vérifiée automatiquement.</div>`
            return
        }

        let shown = this.mods.filter(m => !search
            || String(m.info?.name || '').toLowerCase().includes(search)
            || m.file.toLowerCase().includes(search)
            || String(m.info?.id || '').toLowerCase().includes(search))
        if (!shown.length) {
            list.innerHTML = '<div class="mods-empty"><b>Aucun résultat</b>Aucun mod ne correspond à votre recherche.</div>'
            return
        }

        list.innerHTML = shown.map(mod => {
            let info = mod.info || {}
            let badge = ''
            let detail = ''
            if (!mod.enabled) {
                badge = '<span class="mod-badge off">Désactivé</span>'
            } else if (mod.compat?.errors.length) {
                badge = '<span class="mod-badge error">Incompatible</span>'
                detail = mod.compat.errors[0]
            } else if (mod.compat?.warnings.length) {
                badge = '<span class="mod-badge warn">Dépendance manquante</span>'
                detail = mod.compat.warnings[0]
            } else if (mod.compat?.unknown) {
                badge = '<span class="mod-badge muted">Non vérifié</span>'
            }
            return this.rowHTML({
                file: mod.file,
                enabled: mod.enabled,
                icon: info.icon,
                letter: info.name || mod.file,
                name: info.name || mod.file,
                version: info.version,
                badge,
                meta: detail || mod.file.replace(/\.disabled$/i, ''),
                title: detail || mod.file
            })
        }).join('')
    }

    /**
     * Active ou désactive un mod.
     * @param {object} mod
     * @param {boolean} enabled
     */
    async toggleMod(mod, enabled) {
        try {
            setModEnabled(this.dir, mod.file, enabled)
        } catch (err) {
            this.home.showError(`Impossible de ${enabled ? 'réactiver' : 'désactiver'} ce mod : ${escapeHTML(err.message)}<br>Le jeu est-il encore ouvert ?`)
        }
        this.refreshMods()
    }

    /**
     * Supprime un mod après confirmation.
     * @param {object} mod
     */
    async removeMod(mod) {
        let { confirmed } = await confirmDialog({
            title: 'Supprimer ce mod ?',
            html: `<b>${escapeHTML(mod.info?.name || mod.file)}</b> sera supprimé de l'instance.`,
            confirmText: 'Supprimer',
            danger: true
        })
        if (!confirmed) return
        try {
            deleteMod(this.dir, mod.file)
        } catch (err) {
            this.home.showError(`Suppression impossible : ${escapeHTML(err.message)}`)
        }
        this.refreshMods()
    }

    /** Import avec vérification : demande confirmation pour chaque mod incompatible ou inconnu. */
    async importMods(files) {
        let added = 0
        for (let file of files) {
            if (!/\.jar$/i.test(file)) {
                await confirmDialog({ title: 'Fichier ignoré', html: `<b>${escapeHTML(path.basename(file))}</b> n'est pas un mod (.jar).`, confirmText: 'OK', cancelText: 'Fermer' })
                continue
            }
            let info = readModInfo(file)
            let compat = checkCompatibility(info, this.instance, this.mods)
            let name = escapeHTML(info?.name || path.basename(file))

            if (compat.errors.length) {
                let { confirmed } = await confirmDialog({
                    title: 'Mod incompatible',
                    html: `<b>${name}</b> ne semble pas compatible avec cette instance :${reasonsList(compat.errors)}<span class="danger-text">L'ajouter quand même peut empêcher le jeu de démarrer.</span>`,
                    confirmText: 'Ajouter quand même (danger)',
                    danger: true
                })
                if (!confirmed) continue
            } else if (compat.unknown) {
                let { confirmed } = await confirmDialog({
                    title: 'Compatibilité inconnue',
                    html: `Impossible de lire les informations de <b>${name}</b>. Sa compatibilité ne peut pas être vérifiée.`,
                    confirmText: 'Ajouter quand même',
                    danger: true
                })
                if (!confirmed) continue
            }

            // Même mod déjà présent (autre version) : on propose de remplacer.
            let existing = info?.id && this.mods.find(m => m.info?.id === info.id)
            if (existing) {
                if (existing.file.replace(/\.disabled$/i, '') === path.basename(file)) {
                    let { confirmed } = await confirmDialog({ title: 'Déjà installé', html: `<b>${name}</b> est déjà présent dans cette instance. Le remplacer ?`, confirmText: 'Remplacer' })
                    if (!confirmed) continue
                    deleteMod(this.dir, existing.file)
                } else {
                    let { confirmed } = await confirmDialog({
                        title: 'Autre version installée',
                        html: `<b>${name}</b> est déjà installé en version <b>${escapeHTML(existing.info.version || '?')}</b>.<br>Remplacer par la version <b>${escapeHTML(info.version || '?')}</b> ?`,
                        confirmText: 'Remplacer'
                    })
                    if (!confirmed) continue
                    deleteMod(this.dir, existing.file)
                }
            }

            try {
                importMod(this.dir, file)
                added++
            } catch (err) {
                this.home.showError(`Import de ${name} impossible : ${escapeHTML(err.message)}`)
            }
            this.refreshMods()
        }
        if (added) this.refreshMods()
    }

    /* ------------------------------------------------------------------ */
    /* Packs de textures et shaders                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Relit un dossier de packs, l'état d'activation (options.txt, config du mod de shaders)
     * et la compatibilité de chaque pack.
     * @param {"resourcepacks"|"shaderpacks"} kind
     */
    refreshPacks(kind) {
        let packs = []
        try {
            packs = listPacks(this.dir, kind)
        } catch (err) {
            console.error(`[${kind}]`, err)
        }

        if (kind === 'resourcepacks') {
            this.gameFormat = gameResourceFormat(this.home.gamePath, this.mcVersion)
            let active = activeResourcePacks(this.dir, this.mcVersion)
            for (let pack of packs) {
                pack.compat = packCompatibility(pack.info, this.gameFormat)
                pack.priority = active.indexOf(pack.file)
                pack.enabled = pack.priority >= 0
            }
            // Packs actifs en premier, du plus prioritaire au moins prioritaire (comme dans le jeu).
            packs.sort((a, b) => (b.priority - a.priority) || 0)
        } else {
            this.shaderLoader = shaderLoader(this.mods)
            let active = activeShaderPack(this.dir, this.shaderLoader)
            for (let pack of packs) {
                pack.compat = pack.info?.invalid ? 'invalid' : 'ok'
                pack.enabled = !!this.shaderLoader && pack.file === active
            }
        }
        this.packs[kind] = packs
        this.renderPacks(kind)
    }

    /**
     * Raison lisible d'un problème de pack (null si compatible).
     * @param {object} pack
     * @param {"resourcepacks"|"shaderpacks"} kind
     */
    packProblem(pack, kind) {
        let info = pack.info || {}
        if (pack.compat === 'invalid') {
            if (info.nestedIn) return `Le pack est rangé dans le sous-dossier « ${info.nestedIn} » : le jeu ne le reconnaîtra pas.`
            return kind === 'shaderpacks'
                ? "Ce n'est pas un pack de shaders (dossier shaders/ introuvable)."
                : "Ce n'est pas un pack de textures (pack.mcmeta introuvable)."
        }
        if (pack.compat === 'old') return `Prévu pour ${formatRangeLabel(info.range)}, l'instance est en ${this.mcVersion}.`
        if (pack.compat === 'new') return `Prévu pour ${formatRangeLabel(info.range)}, plus récent que l'instance (${this.mcVersion}).`
        return null
    }

    /**
     * Affiche une liste de packs.
     * @param {"resourcepacks"|"shaderpacks"} kind
     */
    renderPacks(kind) {
        let pane = this.pane(kind)
        let list = pane.querySelector('.pane-list')
        let banner = pane.querySelector('.pane-banner')
        let text = PACK_TEXT[kind]
        let packs = this.packs[kind]
        let search = this.searchOf(kind)
        let shaders = kind === 'shaderpacks'

        this.q(`[data-count="${kind}"]`).textContent = packs.length

        // Bandeau : mod de shaders utilisé ou manquant.
        if (shaders) {
            banner.className = `pane-banner visible${this.shaderLoader ? '' : ' warn'}`
            banner.innerHTML = this.shaderLoader
                ? `Shaders chargés par <b>${escapeHTML(this.shaderLoader.name)}</b>. Un seul pack peut être actif à la fois.`
                : `Aucun mod de shaders actif. Installez <b>Iris</b> (Fabric, Quilt, NeoForge) ou <b>Oculus</b> / <b>OptiFine</b> (Forge) dans l'onglet <a class="pane-goto-mods">Mods</a> pour utiliser vos shaders.`
            let link = banner.querySelector('.pane-goto-mods')
            if (link) link.onclick = () => this.showTab('mods')
        } else {
            banner.className = 'pane-banner'
            banner.innerHTML = ''
        }

        let enabled = packs.filter(p => p.enabled).length
        let problems = packs.filter(p => this.packProblem(p, kind)).length
        pane.querySelector('.pane-summary').innerHTML = packs.length
            ? (shaders
                ? (enabled ? `1 pack actif sur ${packs.length}` : `Shaders désactivés · ${packs.length} pack${packs.length > 1 ? 's' : ''}`)
                : `${enabled} actif${enabled > 1 ? 's' : ''} sur ${packs.length}`)
                + (problems ? ` · <span class="orange">${problems} à vérifier</span>` : '')
            : ''

        if (!packs.length) {
            list.innerHTML = `<div class="mods-empty">${text.icon}<b>${text.empty}</b>Cliquez sur « Importer » ou glissez vos fichiers .zip (ou dossiers) ici.<br>${shaders
                ? 'Le launcher vérifie que le pack est valide et qu\'un mod de shaders est installé.'
                : 'La compatibilité avec la version du jeu est vérifiée automatiquement.'}</div>`
            return
        }

        let shown = packs.filter(p => !search
            || p.file.toLowerCase().includes(search)
            || String(p.info?.description || '').toLowerCase().includes(search))
        if (!shown.length) {
            list.innerHTML = `<div class="mods-empty"><b>Aucun résultat</b>Aucun ${text.one} ne correspond à votre recherche.</div>`
            return
        }

        list.innerHTML = shown.map(pack => {
            let info = pack.info || {}
            let problem = this.packProblem(pack, kind)
            let badge = ''
            if (pack.compat === 'invalid') badge = '<span class="mod-badge error">Invalide</span>'
            else if (pack.compat === 'old') badge = '<span class="mod-badge warn">Ancienne version</span>'
            else if (pack.compat === 'new') badge = '<span class="mod-badge warn">Version plus récente</span>'
            else if (pack.compat === 'unknown') badge = '<span class="mod-badge muted">Non vérifié</span>'
            if (pack.enabled && !shaders && pack.priority === Math.max(...packs.map(p => p.priority)) && enabled > 1) {
                badge += '<span class="mod-badge active">Prioritaire</span>'
            }
            let meta = problem || info.description || (pack.folder ? 'Dossier' : pack.file)
            return this.rowHTML({
                file: pack.file,
                enabled: pack.enabled,
                icon: info.icon,
                letter: info.name || pack.file,
                name: info.name || pack.file,
                badge,
                meta,
                title: problem || info.description || pack.file,
                noDim: true,
                toggleDisabled: shaders && !this.shaderLoader,
                toggleTitle: shaders && !this.shaderLoader ? 'Installez un mod de shaders pour activer ce pack' : (pack.enabled ? 'Désactiver' : 'Activer')
            })
        }).join('')
    }

    /**
     * Active ou désactive un pack. Pour les shaders, activer un pack remplace le précédent.
     * @param {"resourcepacks"|"shaderpacks"} kind
     */
    async togglePack(kind, pack, enabled) {
        try {
            if (kind === 'resourcepacks') {
                setResourcePackEnabled(this.dir, this.mcVersion, pack.file, enabled, pack.compat === 'old' || pack.compat === 'new')
            } else if (this.shaderLoader) {
                setActiveShaderPack(this.dir, this.shaderLoader, enabled ? pack.file : null)
            }
        } catch (err) {
            this.home.showError(`Impossible de modifier ce pack : ${escapeHTML(err.message)}`)
        }
        this.refreshPacks(kind)
    }

    /**
     * Supprime un pack (archive ou dossier) après confirmation.
     * @param {"resourcepacks"|"shaderpacks"} kind
     */
    async removePack(kind, pack) {
        let { confirmed } = await confirmDialog({
            title: `Supprimer ce ${PACK_TEXT[kind].one} ?`,
            html: `<b>${escapeHTML(pack.file)}</b> sera supprimé de l'instance.`,
            confirmText: 'Supprimer',
            danger: true
        })
        if (!confirmed) return
        try {
            if (pack.enabled) {
                if (kind === 'resourcepacks') setResourcePackEnabled(this.dir, this.mcVersion, pack.file, false)
                else if (this.shaderLoader) setActiveShaderPack(this.dir, this.shaderLoader, null)
            }
            deletePack(this.dir, kind, pack.file)
        } catch (err) {
            this.home.showError(`Suppression impossible : ${escapeHTML(err.message)}`)
        }
        this.refreshPacks(kind)
    }

    /**
     * Import de packs avec vérification : confirmation pour un pack invalide, prévu pour une autre
     * version, ou un shader sans mod de shaders.
     * @param {"resourcepacks"|"shaderpacks"} kind
     * @param {string[]} files Archives .zip ou dossiers
     */
    async importPacks(kind, files) {
        let text = PACK_TEXT[kind]
        let shaders = kind === 'shaderpacks'
        let warnedLoader = false
        for (let file of files) {
            let base = path.basename(file)
            let isDir = false
            try { isDir = fs.statSync(file).isDirectory() } catch { continue }
            if (!isDir && !/\.zip$/i.test(file)) {
                await confirmDialog({ title: 'Fichier ignoré', html: `<b>${escapeHTML(base)}</b> n'est pas un ${text.one} (.zip ou dossier).`, confirmText: 'OK', cancelText: 'Fermer' })
                continue
            }

            let info = shaders ? readShaderPack(file) : readResourcePack(file)
            let pack = { info, compat: shaders ? (info?.invalid ? 'invalid' : 'ok') : packCompatibility(info, this.gameFormat) }
            let problem = this.packProblem(pack, kind)
            let name = escapeHTML(base)

            if (pack.compat === 'invalid') {
                let { confirmed } = await confirmDialog({
                    title: shaders ? 'Pack de shaders invalide' : 'Pack de textures invalide',
                    html: `<b>${name}</b> :${reasonsList([problem])}${info?.nestedIn ? 'Extrayez ce sous-dossier, ou recompressez son contenu, puis réessayez.' : `Ce fichier ne sera pas reconnu comme ${text.one} par le jeu.`}`,
                    confirmText: 'Ajouter quand même',
                    danger: true
                })
                if (!confirmed) continue
            } else if (pack.compat === 'old' || pack.compat === 'new') {
                let { confirmed } = await confirmDialog({
                    title: 'Pack prévu pour une autre version',
                    html: `<b>${name}</b> n'est pas prévu pour cette version :${reasonsList([problem])}Le jeu le signalera comme incompatible : certaines textures peuvent manquer ou s'afficher incorrectement.`,
                    confirmText: 'Ajouter quand même'
                })
                if (!confirmed) continue
            } else if (shaders && !this.shaderLoader && !warnedLoader) {
                warnedLoader = true
                let { confirmed } = await confirmDialog({
                    title: 'Aucun mod de shaders',
                    html: `Pour utiliser <b>${name}</b>, l'instance a besoin d'un mod de shaders : <b>Iris</b> (Fabric, Quilt, NeoForge) ou <b>Oculus</b> / <b>OptiFine</b> (Forge).<br>Le pack sera ajouté mais inutilisé tant qu'aucun n'est installé.`,
                    confirmText: 'Ajouter quand même'
                })
                if (!confirmed) continue
            }

            let existing = this.packs[kind].find(p => p.file.toLowerCase() === base.toLowerCase())
            if (existing) {
                let { confirmed } = await confirmDialog({ title: 'Déjà présent', html: `<b>${name}</b> est déjà dans cette instance. Le remplacer ?`, confirmText: 'Remplacer' })
                if (!confirmed) continue
                try { deletePack(this.dir, kind, existing.file) } catch { }
            }

            try {
                importPack(this.dir, kind, file)
            } catch (err) {
                this.home.showError(`Import de ${name} impossible : ${escapeHTML(err.message)}`)
            }
            this.refreshPacks(kind)
        }
    }

    /* ------------------------------------------------------------------ */
    /* Paramètres                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * Ce qui diffère entre le formulaire et l'instance enregistrée.
     * @returns {{name: boolean, color: boolean, version: boolean, api: boolean}}
     */
    changes() {
        let d = this.form.data()
        let i = this.instance
        return {
            name: d.name !== i.name,
            color: d.color !== i.color,
            version: d.minecraft_version !== i.loadder.minecraft_version
                || d.loadder_type !== (i.loadder.loadder_type || 'none')
                || (d.loadder_type !== 'none' && d.loadder_version !== i.loadder.loadder_version),
            api: (d.fabricApi?.filename || null) !== (i.fabricApi?.filename || null)
        }
    }

    /** Active le bouton Enregistrer s'il y a des changements valides. */
    updateSaveState() {
        if (!this.instance) return
        let c = this.changes()
        let changed = c.name || c.color || c.version || c.api
        this.q('.edit-save').classList.toggle('disabled', !changed || !this.form.ready())
        this.q('.edit-version-note').classList.toggle('visible', c.version && (this.mods.length > 0 || this.packs.resourcepacks.length > 0))
    }

    /** Enregistre les paramètres (renommage du dossier, changement de version après confirmation). */
    async save() {
        let btn = this.q('.edit-save')
        if (btn.classList.contains('disabled') || this.saving) return
        let d = this.form.data()
        let c = this.changes()

        let name = this.instance.name
        if (c.name) {
            let check = await validateName(d.name, this.home.instances.official, this.instance.name)
            if (check.error) return this.form.setError(check.error)
            name = check.name
        }

        if (c.version && this.mods.length) {
            let { confirmed } = await confirmDialog({
                title: 'Changer de version ?',
                html: `L'instance passera en <b>${escapeHTML(loaderLabel({ loadder: d }))}</b> pour Minecraft <b>${escapeHTML(d.minecraft_version)}</b>.<br>Vos ${this.mods.length} mods sont conservés, mais certains peuvent devenir incompatibles.`,
                confirmText: 'Changer de version'
            })
            if (!confirmed) return
        }

        this.saving = true
        btn.classList.add('disabled')
        try {
            let wasSelected = (await this.home.db.readData('configClient'))?.instance_selct === this.instance.name
            let updated = await updateLocalInstance(this.instance.name, {
                name,
                color: d.color,
                loadder: {
                    minecraft_version: d.minecraft_version,
                    loadder_type: d.loadder_type,
                    loadder_version: d.loadder_version
                },
                fabricApi: d.fabricApi
            }, this.home.gamePath)
            this.instance = updated
            if (wasSelected) await this.home.selectInstance(updated.name, { silent: true })
            await this.home.refreshInstances()
            this.form.reset({ ...updated.loadder, name: updated.name, color: updated.color, fabricApi: updated.fabricApi || null })
            this.formLoaded = false
            this.showTab('general')
            this.renderHeader()
            this.refreshAll()
        } catch (err) {
            console.error(err)
            this.form.setError(err.message)
        } finally {
            this.saving = false
            this.updateSaveState()
        }
    }

    /** Supprime l'instance après confirmation (fichiers optionnels, mondes conservés). */
    async deleteInstance() {
        let { confirmed, checked } = await confirmDialog({
            title: "Supprimer l'instance ?",
            html: `L'instance <b>${escapeHTML(this.instance.name)}</b> sera retirée du launcher.`,
            checkbox: 'Supprimer aussi ses fichiers (mods, packs, configs...). Les mondes partagés sont conservés.',
            confirmText: 'Supprimer',
            danger: true
        })
        if (!confirmed) return
        try {
            await deleteLocalInstance(this.instance.name, this.home.gamePath, checked)
        } catch (err) {
            console.error(err)
            return this.home.showError(`Suppression impossible : ${escapeHTML(err.message)}`)
        }
        this.close()
        await this.home.refreshInstances()
        this.home.openInstancePicker()
    }
}
