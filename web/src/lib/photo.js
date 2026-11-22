// Photos : réduction avant l'envoi (JPEG, 1280 px au plus) et affichage des
// photos protégées (chargées avec le jeton de connexion).
import { getToken } from '../auth.js';
import { state } from '../state.js';

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** Fichier image → { type, data (base64) } réduit. */
export async function shrinkPhoto(file, max = 1280, quality = 0.8) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { type: 'image/jpeg', data: btoa(bin) };
}

const cache = new Map();
/** Adresse locale (blob:) de la photo d'un lieu ; `version` invalide le cache. */
export async function placePhotoUrl(placeId, version = '') {
  const key = `${placeId}:${version}`;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const token = await getToken();
      const res = await fetch(`${BASE}/api/places/${placeId}/photo`, { headers: { Authorization: `Bearer ${token}`, 'X-Tenant-Id': state.tenantId ?? '' } });
      if (!res.ok) return null;
      return URL.createObjectURL(await res.blob());
    })());
  }
  return cache.get(key);
}

/** Vignette qui s'ouvre en grand au toucher. */
export function photoThumb(h, placeId, version, alt) {
  const img = h('img.photo-thumb', { alt, loading: 'lazy' });
  placePhotoUrl(placeId, version).then((u) => { if (u) img.src = u; else img.remove(); });
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    const big = h('div.photo-viewer', { onclick: () => big.remove() }, h('img', { src: img.src, alt }));
    document.body.append(big);
  });
  return img;
}

/** Petite icône 📷 : la photo n'est chargée qu'au toucher (listes longues). */
export function photoIcon(h, placeId, version, alt) {
  return h('button.photo-icon', { type: 'button', title: `Photo : ${alt}`, 'aria-label': `Voir la photo : ${alt}`, onclick: async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.classList.add('loading');
    const src = await placePhotoUrl(placeId, version);
    btn.classList.remove('loading');
    if (!src) return;
    const big = h('div.photo-viewer', { onclick: () => big.remove() }, h('img', { src, alt }));
    document.body.append(big);
  } }, '📷');
}
