/**
 * Fenêtre d'édition d'une instance personnelle :
 *  - onglet Mods : liste avec activation, suppression, import (bouton ou glisser-déposer)
 *    et vérification de compatibilité avant ajout ;
 *  - onglet Paramètres : nom, couleur, version, loader, Fabric API, suppression.
 */

import InstanceForm, { escapeHTML, initials, loaderLabel } from '../utils/instanceForm.js'
import { confirmDialog, reasonsList } from '../utils/dialog.js'
import { listMods, setModEnabled, importMod, deleteMod, readModInfo, checkCompatibility, modsFolder } from '../utils/mods.js'
import { instanceFolder, validateName, updateLocalInstance, deleteLocalInstance } from '../utils/instances.js'

const { shell } = require('electron')
const fs = require('fs')
const path = require('path')

const ICON_TRASH = '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z"/></svg>'
const ICON_PUZZLE = '<svg viewBox="0 0 24 24"><path d="M10 3a2 2 0 0 1 2 2v1h4a1 1 0 0 1 1 1v4h1a2 2 0 1 1 0 4h-1v4a1 1 0 0 1-1 1h-4v-1a2 2 0 1 0-4 0v1H4a1 1 0 0 1-1-1v-4h1a2 2 0 1 0 0-4H3V7a1 1 0 0 1 1-1h4V5a2 2 0 0 1 2-2z"/></svg>'

export default class InstanceEditor {
    constructor(home) {
        this.home = home
        this.root = document.querySelector('.edit-popup')
        this.instance = null
        this.mods = []
        this.formLoaded = false
        this.form = new InstanceForm(this.root.querySelector('.edit-general'), { onChange: () => this.updateSaveState() })
        this.bind()
    }

    get dir() {
        return instanceFolder(this.home.gamePath, this.instance)
    }

    /** Raccourci querySelector limité à la fenêtre d'édition. */
    q(selector) {
        return this.root.querySelector(selector)
    }

    /** Branche les onglets, la liste des mods, l'import (bouton et glisser-déposer) et les paramètres. */
    bind() {
        let close = () => this.close()
        this.q('.edit-close').addEventListener('click', close)
        this.q('.edit-back').addEventListener('click', () => { this.close(); this.home.openInstancePicker() })
        this.root.addEventListener('mousedown', e => { if (e.target === this.root) close() })

        this.q('.edit-tabs').addEventListener('click', e => {
            let btn = e.target.closest('.edit-tab-btn')
            if (btn) this.showTab(btn.dataset.tab)
        })

        // --- Mods ---
        this.q('.mods-search').addEventListener('input', () => this.renderMods())
        this.q('.mods-open-folder').addEventListener('click', () => {
            fs.mkdirSync(modsFolder(this.dir), { recursive: true })
            shell.openPath(modsFolder(this.dir))
        })
        let fileInput = this.q('.mods-file')
        this.q('.mods-import').addEventListener('click', () => {
            fileInput.value = ''
            fileInput.click()
        })
        fileInput.addEventListener('change', () => {
            let files = [...fileInput.files].map(f => f.path).filter(Boolean)
            if (files.length) this.importFiles(files)
        })

        this.q('.mods-list').addEventListener('click', e => {
            let row = e.target.closest('.mod-row')
            if (!row) return
            let mod = this.mods.find(m => m.file === row.dataset.file)
            if (!mod) return
            if (e.target.closest('.mod-delete')) return this.removeMod(mod)
        })
        this.q('.mods-list').addEventListener('change', e => {
            let toggle = e.target.closest('.mod-toggle')
            if (!toggle) return
            let mod = this.mods.find(m => m.file === toggle.closest('.mod-row').dataset.file)
            if (mod) this.toggleMod(mod, toggle.checked)
        })

        // Glisser-déposer de .jar sur l'onglet Mods
        let pane = this.q('.edit-pane-mods')
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
            if (files.length) this.importFiles(files)
        })

        // --- Paramètres ---
        this.q('.edit-save').addEventListener('click', () => this.save())
        this.q('.edit-delete').addEventListener('click', () => this.deleteInstance())
    }

    /** L'élément glissé contient-il des fichiers ? */
    hasFiles(e) {
        return [...(e.dataTransfer?.types || [])].includes('Files')
    }

    /**
     * Ouvre l'éditeur pour une instance.
     * @param {object} instance Instance locale
     * @param {"mods"|"general"} [tab]
     */
    open(instance, tab = 'mods') {
        this.instance = instance
        this.formLoaded = false
        this.q('.mods-search').value = ''
        this.renderHeader()
        this.form.reset(instance.loadder ? {
            name: instance.name,
            color: instance.color,
            minecraft_version: instance.loadder.minecraft_version,
            loadder_type: instance.loadder.loadder_type || 'none',
            loadder_version: instance.loadder.loadder_version,
            fabricApi: instance.fabricApi || null
        } : {})
        this.refreshMods()
        this.showTab(tab)
        this.home.openPopup('.edit-popup')
    }

    /** Ferme l'éditeur. */
    close() {
        this.home.closePopup('.edit-popup')
    }

    /**
     * Affiche un onglet ; les versions ne sont chargées qu'à la première ouverture des paramètres.
     * @param {"mods"|"general"} tab
     */
    showTab(tab) {
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
    }

    /** Affiche la liste des mods (filtrée par la recherche) avec leurs badges. */
    renderMods() {
        let list = this.q('.mods-list')
        let search = this.q('.mods-search').value.trim().toLowerCase()
        let vanilla = (this.instance.loadder?.loadder_type || 'none') === 'none'
        let enabled = this.mods.filter(m => m.enabled).length
        let problems = this.mods.filter(m => m.compat && (m.compat.errors.length || m.compat.warnings.length)).length

        this.q('.edit-mods-count').textContent = this.mods.length
        this.q('.mods-summary').innerHTML = this.mods.length
            ? `${enabled} actif${enabled > 1 ? 's' : ''} sur ${this.mods.length}${problems ? ` · <span class="orange">${problems} à vérifier</span>` : ''}`
            : ''

        if (vanilla) {
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
            let badges = ''
            let detail = ''
            if (!mod.enabled) {
                badges = '<span class="mod-badge off">Désactivé</span>'
            } else if (mod.compat?.errors.length) {
                badges = '<span class="mod-badge error">Incompatible</span>'
                detail = mod.compat.errors[0]
            } else if (mod.compat?.warnings.length) {
                badges = '<span class="mod-badge warn">Dépendance manquante</span>'
                detail = mod.compat.warnings[0]
            } else if (mod.compat?.unknown) {
                badges = '<span class="mod-badge muted">Non vérifié</span>'
            }
            let icon = info.icon
                ? `<div class="mod-icon" style="background-image:url('${info.icon}')"></div>`
                : `<div class="mod-icon mod-icon-letter">${escapeHTML(initials(info.name || mod.file))}</div>`
            return `
                <div class="mod-row${mod.enabled ? '' : ' disabled'}" data-file="${escapeHTML(mod.file)}">
                    ${icon}
                    <div class="mod-body">
                        <div class="mod-name">${escapeHTML(info.name || mod.file)} <span class="mod-version">${escapeHTML(info.version || '')}</span> ${badges}</div>
                        <div class="mod-meta" title="${escapeHTML(detail || mod.file)}">${escapeHTML(detail || mod.file.replace(/\.disabled$/i, ''))}</div>
                    </div>
                    <label class="switch" title="${mod.enabled ? 'Désactiver' : 'Activer'}"><input type="checkbox" class="mod-toggle"${mod.enabled ? ' checked' : ''}/><span></span></label>
                    <div class="icon-btn danger mod-delete" title="Supprimer">${ICON_TRASH}</div>
                </div>`
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
    async importFiles(files) {
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
        this.q('.edit-version-note').classList.toggle('visible', c.version && this.mods.length > 0)
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
            this.refreshMods()
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
            checkbox: 'Supprimer aussi ses fichiers (mods, configs...). Les mondes partagés sont conservés.',
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
