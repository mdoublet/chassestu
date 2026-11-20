// Poignée entre la carte et le panneau latéral : glisser pour élargir le
// panneau (largeur mémorisée sur l'appareil), double-clic : largeur par défaut.
import { h } from '../ui.js';

export function panelResizer(panel, { key, defaultWidth = null, onResize = () => {} }) {
  const setWidth = (w) => { panel.style.width = `${Math.round(Math.min(Math.max(w, 280), window.innerWidth * 0.75))}px`; };
  const reset = () => { if (defaultWidth) setWidth(defaultWidth); else panel.style.width = ''; };
  let stored = 0;
  try { stored = Number(localStorage.getItem(key)); } catch { /* rien */ }
  if (stored) setWidth(stored); else reset();
  const el = h('div.resizer', { title: 'Glisser pour élargir le panneau (double-clic : largeur par défaut)', role: 'separator', 'aria-orientation': 'vertical' });
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const right = panel.getBoundingClientRect().right;
    const move = (ev) => setWidth(right - ev.clientX);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.classList.remove('dragging');
      try { localStorage.setItem(key, String(panel.offsetWidth)); } catch { /* rien */ }
      onResize();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
  });
  el.addEventListener('dblclick', () => {
    reset();
    try { localStorage.removeItem(key); } catch { /* rien */ }
    onResize();
  });
  return el;
}
