// Petites aides DOM, sans framework.

/**
 * h('button.primary', { onclick }, 'Texte') — crée un élément.
 * Les chaînes enfants sont insérées comme texte (jamais comme HTML).
 */
export function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = {};
  }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

/** Remplace le contenu de `el` ; ignore null/false (que replaceChildren écrirait « null »). */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

let toastTimer;
export function toast(message, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.className = `toast ${kind} show`;
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 6000 : 3000);
}

export function errorMessage(err) {
  return err?.message || 'Une erreur est survenue.';
}

/** Boîte de dialogue modale ; renvoie une promesse résolue à la fermeture. */
export function modal(title, content, actions = [{ label: 'Fermer', value: null }]) {
  return new Promise((resolve) => {
    const dialog = h('dialog.modal');
    const close = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.append(
      h('h2', title),
      h('div.modal-body', content),
      h(
        'div.modal-actions',
        actions.map((a) =>
          h(`button${a.primary ? '.primary' : ''}${a.danger ? '.danger' : ''}`, {
            type: 'button',
            onclick: async () => {
              if (a.onClick) {
                const keepOpen = await a.onClick();
                if (keepOpen === false) return;
              }
              close(a.value);
            },
          }, a.label),
        ),
      ),
    );
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

export async function confirmDialog(title, message, confirmLabel = 'Confirmer', danger = false) {
  const v = await modal(title, h('p', message), [
    { label: 'Annuler', value: false },
    { label: confirmLabel, value: true, primary: !danger, danger },
  ]);
  return v === true;
}

export async function promptDialog(title, label, initial = '') {
  const input = h('input', { value: initial, required: true, maxlength: 200 });
  setTimeout(() => input.focus(), 50);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.closest('dialog').querySelector('button.primary').click();
  });
  const v = await modal(title, h('label', label, input), [
    { label: 'Annuler', value: null },
    { label: 'Valider', primary: true, value: 'ok' },
  ]);
  return v === 'ok' ? input.value.trim() : null;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copié dans le presse-papiers.');
  } catch {
    await modal('Copier', h('textarea.copy', { readOnly: true, rows: 4 }, text));
  }
}

export const ROLE_LABELS = { president: 'Président', responsable: 'Responsable de battue', chasseur: 'Chasseur' };

export function formatDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}
