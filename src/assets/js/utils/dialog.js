/**
 * Boîte de confirmation générique, affichée par-dessus toutes les fenêtres.
 *
 *   let { confirmed, checked } = await confirmDialog({
 *       title: 'Mod incompatible', html: '...', confirmText: 'Ajouter quand même',
 *       danger: true, checkbox: 'Supprimer aussi les fichiers'
 *   })
 *
 *   // Avec un champ texte et une action qui garde la boîte ouverte tant qu'elle échoue :
 *   let { confirmed, value } = await confirmDialog({
 *       title: 'Nom', input: { value: 'Copie' }, busyText: 'Copie...',
 *       onConfirm: async value => erreur ? 'Message d'erreur' : null
 *   })
 */

import { escapeHTML } from './instanceForm.js';

let current = null;

/**
 * Crée (une fois) l'élément de la boîte de confirmation.
 * @returns {HTMLElement}
 */
function element() {
    let root = document.querySelector('.confirm-dialog');
    if (root) return root;
    root = document.createElement('div');
    root.className = 'confirm-dialog';
    root.innerHTML = `
        <div class="confirm-dialog-tab">
            <div class="confirm-dialog-head">
                <div class="confirm-dialog-icon"></div>
                <p class="modal-title confirm-dialog-title"></p>
            </div>
            <div class="confirm-dialog-text"></div>
            <input type="text" class="field-input confirm-dialog-input" maxlength="32" spellcheck="false"/>
            <div class="confirm-dialog-error"></div>
            <label class="checkbox-line confirm-dialog-check">
                <input type="checkbox"/>
                <span></span>
            </label>
            <div class="confirm-dialog-buttons">
                <div class="btn btn-secondary confirm-dialog-cancel"></div>
                <div class="btn confirm-dialog-ok"></div>
            </div>
        </div>`;
    document.querySelector('.panels').appendChild(root);
    return root;
}

/**
 * Affiche une boîte de confirmation et attend la réponse du joueur.
 * Entrée = confirmer, Échap ou clic à côté = annuler.
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.html] Contenu (HTML déjà échappé)
 * @param {string} [options.confirmText]
 * @param {string} [options.cancelText]
 * @param {boolean} [options.danger] Bouton rouge
 * @param {string} [options.checkbox] Libellé d'une case à cocher optionnelle
 * @param {{value?: string, placeholder?: string}} [options.input] Champ texte (prérempli et sélectionné)
 * @param {(value: string) => Promise<string|null>} [options.onConfirm] Action lancée à la confirmation ;
 *        si elle renvoie un message, il est affiché et la boîte reste ouverte
 * @param {string} [options.busyText] Libellé du bouton pendant `onConfirm`
 * @returns {Promise<{confirmed: boolean, checked: boolean, value: string}>}
 */
export function confirmDialog({ title, html = '', confirmText = 'Confirmer', cancelText = 'Annuler', danger = false, checkbox = null, icon = danger ? '!' : '?', input = null, onConfirm = null, busyText = null }) {
    if (current) current(false);
    let root = element();
    root.querySelector('.confirm-dialog-title').textContent = title;
    root.querySelector('.confirm-dialog-text').innerHTML = html;
    root.querySelector('.confirm-dialog-icon').textContent = icon;
    root.querySelector('.confirm-dialog-icon').classList.toggle('danger', danger);
    let check = root.querySelector('.confirm-dialog-check');
    check.style.display = checkbox ? '' : 'none';
    check.querySelector('span').textContent = checkbox || '';
    check.querySelector('input').checked = false;
    let ok = root.querySelector('.confirm-dialog-ok');
    ok.textContent = confirmText;
    ok.className = `btn confirm-dialog-ok ${danger ? 'btn-danger' : 'btn-primary'}`;
    root.querySelector('.confirm-dialog-cancel').textContent = cancelText;
    let field = root.querySelector('.confirm-dialog-input');
    let error = root.querySelector('.confirm-dialog-error');
    field.style.display = input ? '' : 'none';
    field.value = input?.value || '';
    field.placeholder = input?.placeholder || '';
    error.textContent = '';
    field.oninput = () => { error.textContent = ''; };
    root.style.display = 'flex';
    if (input) setTimeout(() => { field.focus(); field.select(); }, 0);

    return new Promise(resolve => {
        let busy = false;
        let confirm = async () => {
            if (busy) return;
            if (!onConfirm) return cleanup(true);
            busy = true;
            ok.classList.add('disabled');
            ok.textContent = busyText || confirmText;
            let message = null;
            try {
                message = await onConfirm(field.value.trim());
            } catch (err) {
                message = err.message || String(err);
            }
            busy = false;
            ok.classList.remove('disabled');
            ok.textContent = confirmText;
            if (message) error.textContent = message;
            else cleanup(true);
        };
        let cleanup = result => {
            if (busy) return; // une action est en cours : on attend sa fin
            current = null;
            root.style.display = 'none';
            ok.onclick = null;
            root.querySelector('.confirm-dialog-cancel').onclick = null;
            root.onmousedown = null;
            document.removeEventListener('keydown', onKey, true);
            resolve({ confirmed: result, checked: check.querySelector('input').checked, value: field.value.trim() });
        };
        let onKey = e => {
            if (e.key === 'Escape') { e.stopPropagation(); cleanup(false); }
            if (e.key === 'Enter') { e.stopPropagation(); confirm(); }
        };
        current = cleanup;
        ok.onclick = () => confirm();
        root.querySelector('.confirm-dialog-cancel').onclick = () => cleanup(false);
        root.onmousedown = e => { if (e.target === root) cleanup(false); };
        document.addEventListener('keydown', onKey, true);
    });
}

/**
 * Liste HTML (échappée) de raisons, pour le contenu d'une boîte de confirmation.
 * @param {string[]} items
 * @returns {string}
 */
export function reasonsList(items) {
    return `<ul class="confirm-dialog-list">${items.map(i => `<li>${escapeHTML(i)}</li>`).join('')}</ul>`;
}
