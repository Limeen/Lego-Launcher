/**
 * Boîte de confirmation générique, affichée par-dessus toutes les fenêtres.
 *
 *   let { confirmed, checked } = await confirmDialog({
 *       title: 'Mod incompatible', html: '...', confirmText: 'Ajouter quand même',
 *       danger: true, checkbox: 'Supprimer aussi les fichiers'
 *   })
 */

import { escapeHTML } from './instanceForm.js';

let current = null;

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

export function confirmDialog({ title, html = '', confirmText = 'Confirmer', cancelText = 'Annuler', danger = false, checkbox = null, icon = danger ? '!' : '?' }) {
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
    root.style.display = 'flex';

    return new Promise(resolve => {
        let cleanup = result => {
            current = null;
            root.style.display = 'none';
            ok.onclick = null;
            root.querySelector('.confirm-dialog-cancel').onclick = null;
            root.onmousedown = null;
            document.removeEventListener('keydown', onKey, true);
            resolve({ confirmed: result, checked: check.querySelector('input').checked });
        };
        let onKey = e => {
            if (e.key === 'Escape') { e.stopPropagation(); cleanup(false); }
            if (e.key === 'Enter') { e.stopPropagation(); cleanup(true); }
        };
        current = cleanup;
        ok.onclick = () => cleanup(true);
        root.querySelector('.confirm-dialog-cancel').onclick = () => cleanup(false);
        root.onmousedown = e => { if (e.target === root) cleanup(false); };
        document.addEventListener('keydown', onKey, true);
    });
}

export function reasonsList(items) {
    return `<ul class="confirm-dialog-list">${items.map(i => `<li>${escapeHTML(i)}</li>`).join('')}</ul>`;
}
