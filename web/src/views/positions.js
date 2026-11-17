// Positions en direct sur la carte de la vue chasseur (battue en cours).
// - Chacun peut afficher SA position (reste sur le téléphone, rien n'est envoyé).
// - Avec son accord pour cette battue, elle est envoyée au responsable
//   (15 s en mouvement, 60 s à l'arrêt ; la plus récente seulement).
// - Président et responsables voient la position et le statut des présents.
import L from '../map/leaflet.js';
import { toLatLng, escapeHtml } from '../map/shapes.js';
import { api } from '../api.js';
import { h, fill, toast, errorMessage } from '../ui.js';
import { distanceMeters } from '../lib/simplify.js';
import { shouldSend, ownStatus, POSITION_STATUS, formatAge, formatDistance, MOVING_MS } from '../lib/geoloc.js';

const ROLE_SHORT = { poste: 'posté', traqueur: 'traqueur', chef_de_ligne: 'chef de ligne' };

export function positionPanel(map, { huntId, canSeeAll }) {
  const el = h('section.card.positions');
  const othersLayer = L.layerGroup().addTo(map);
  const meLayer = L.layerGroup().addTo(map);
  let sheet = null;
  let tolerance = 30;
  let sharing = false;
  let others = [];
  let watchId = null;
  let fix = null;           // dernière mesure { lon, lat, accuracy, at }
  let geoError = null;
  let lastSent = null;
  let sending = false;
  let wakeLock = null;
  let pollTimer = null;
  let sendTimer = null;
  let active = false;
  let centeredOnMe = false;
  let fittedOthers = false;

  const running = () => sheet?.hunt.status === 'en_cours';
  const canShare = () => !!sheet?.me && !sheet.me.guest;

  // --- Mesures GPS (téléphone) -------------------------------------------
  function startWatch() {
    if (watchId !== null) return;
    if (!('geolocation' in navigator)) {
      geoError = 'Ce navigateur ne donne pas accès au GPS.';
      render();
      return;
    }
    geoError = null;
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        fix = { lon: p.coords.longitude, lat: p.coords.latitude, accuracy: Math.round(p.coords.accuracy), at: p.timestamp };
        geoError = null;
        drawMe();
        render();
        maybeSend();
      },
      (err) => {
        geoError = err.code === err.PERMISSION_DENIED
          ? 'Accès à la position refusé : autorisez-le dans les réglages du navigateur.'
          : 'Position indisponible pour l’instant (couvert forestier, GPS désactivé ?).';
        render();
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
    );
    render();
  }
  function stopWatch() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    fix = null;
    meLayer.clearLayers();
    releaseWakeLock();
  }

  function drawMe() {
    meLayer.clearLayers();
    if (!fix) return;
    const ll = [fix.lat, fix.lon];
    L.circle(ll, { radius: fix.accuracy, color: '#1c7ed6', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(meLayer);
    L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#1c7ed6', fillOpacity: 1 }).bindTooltip('Vous').addTo(meLayer);
    if (!centeredOnMe) {
      centeredOnMe = true;
      const post = sheet?.post?.geom?.coordinates;
      map.fitBounds(L.latLngBounds([ll, ...(post ? [toLatLng(post)] : [])]).pad(0.3), { maxZoom: 17 });
    }
  }

  // À l'arrêt, watchPosition peut ne plus rien produire : on redemande une
  // mesure fraîche plutôt que de renvoyer une ancienne (sinon « sans signal »).
  function refreshFix() {
    if (!sharing || watchId === null || document.visibilityState !== 'visible') return;
    if (fix && Date.now() - fix.at < 50_000) return maybeSend();
    navigator.geolocation.getCurrentPosition(
      (p) => {
        fix = { lon: p.coords.longitude, lat: p.coords.latitude, accuracy: Math.round(p.coords.accuracy), at: p.timestamp };
        drawMe();
        render();
        maybeSend();
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
    );
  }

  // --- Envoi au serveur (si accord) --------------------------------------
  async function maybeSend(force = false) {
    if (!sharing || !running() || !fix || sending) return;
    if (!force && !shouldSend(lastSent, fix)) return;
    sending = true;
    try {
      await api.post(`/hunts/${huntId}/position`, { lon: fix.lon, lat: fix.lat, accuracy: fix.accuracy, recorded_at: new Date(fix.at).toISOString() });
      lastSent = { lon: fix.lon, lat: fix.lat, sentAt: Date.now() };
    } catch (err) {
      // Accord retiré ou battue terminée : on arrête ; réseau absent : on réessaiera.
      if (err.status === 403 || err.status === 422) {
        sharing = false;
        render();
      }
    } finally {
      sending = false;
    }
  }

  async function setSharing(share) {
    try {
      await api.put(`/hunts/${huntId}/position-sharing`, { share });
      sharing = share;
      lastSent = null;
      if (share) {
        startWatch();
        acquireWakeLock();
        maybeSend(true);
        toast('Position partagée avec le responsable pendant cette battue.');
      } else {
        releaseWakeLock();
        toast('Partage arrêté ; votre position a été effacée.');
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    render();
  }

  // Écran allumé pendant le partage (le GPS s'arrête écran verrouillé).
  async function acquireWakeLock() {
    try {
      if (sharing && !wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock?.request('screen');
        wakeLock?.addEventListener('release', () => { wakeLock = null; });
      }
    } catch {
      /* non disponible : tant pis */
    }
  }
  function releaseWakeLock() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    acquireWakeLock();
    maybeSend(true);
    poll();
  };
  document.addEventListener('visibilitychange', onVisible);

  // --- Positions connues du serveur (accord, tolérance, autres participants)
  async function poll() {
    if (!active) return;
    try {
      const res = await api.get(`/hunts/${huntId}/positions`);
      tolerance = res.tolerance_m;
      if (res.sharing !== sharing) {
        sharing = res.sharing;
        if (sharing) {
          startWatch();
          acquireWakeLock();
        }
      }
      others = res.participants.filter((p) => !p.mine);
      drawOthers();
      render();
    } catch {
      /* réseau : on réessaiera */
    }
  }

  /** Cadre la carte sur les participants localisés (et sa propre position). */
  function fitEveryone() {
    const pts = others.filter((p) => p.lon !== null).map((p) => [p.lat, p.lon]);
    if (fix) pts.push([fix.lat, fix.lon]);
    if (!pts.length) return toast('Personne n’est localisé pour l’instant.');
    map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 17 });
    map.getContainer().scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function focusOn(p) {
    map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16));
    map.getContainer().scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function drawOthers() {
    othersLayer.clearLayers();
    if (!canSeeAll) return;
    // Première réception : la carte du responsable montre tout le monde.
    if (!fittedOthers && others.some((p) => p.lon !== null)) {
      fittedOthers = true;
      const pts = others.filter((p) => p.lon !== null).map((p) => [p.lat, p.lon]);
      const post = sheet?.post?.geom?.coordinates;
      if (post) pts.push(toLatLng(post));
      map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 17 });
    }
    for (const p of others) {
      if (p.lon === null) continue;
      const st = POSITION_STATUS[p.status] ?? POSITION_STATUS.localise;
      L.circleMarker([p.lat, p.lon], { radius: 7, color: '#fff', weight: 2, fillColor: st.color, fillOpacity: 1 })
        .bindTooltip(`${escapeHtml(p.name)}${p.post_number ? ` · poste ${p.post_number}` : ''}<br>${st.label} · ${formatAge(p.age_s)} · ±${Math.round(p.accuracy_m)} m`)
        .addTo(othersLayer);
    }
  }

  // --- Affichage ----------------------------------------------------------
  function render() {
    if (!running() || (!canShare() && !canSeeAll)) {
      fill(el);
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const post = sheet.post?.geom?.coordinates ?? null;
    const st = ownStatus(fix, post, tolerance);
    const mine = fix
      ? h('p.my-position',
          h('span.dot', { style: `background:${POSITION_STATUS[st].color}` }),
          h('strong', POSITION_STATUS[st].label),
          post ? ` · ${formatDistance(distanceMeters([fix.lon, fix.lat], post))} de votre poste (à vol d’oiseau)` : '',
          h('span.small.muted', ` · précision ±${fix.accuracy} m`))
      : watchId !== null && !geoError ? h('p.small.muted', 'Recherche du signal GPS…') : null;

    const share = canShare()
      ? h('label.check.share',
          h('input', { type: 'checkbox', checked: sharing, onchange: (e) => setSharing(e.target.checked) }),
          'Partager ma position avec le responsable pendant cette battue')
      : null;

    const list = canSeeAll && others.length
      ? (() => {
          const shared = others.filter((p) => p.shared);
          const onPost = others.filter((p) => p.status === 'sur_poste').length;
          const posted = others.filter((p) => p.role === 'poste').length;
          return [
            h('h3', `Participants · ${onPost} sur leur poste / ${posted} posté(s)`),
            h('ul.plain.position-list', others.map((p) => {
              const s = POSITION_STATUS[p.status] ?? POSITION_STATUS.localise;
              return h('li', p.lon !== null ? { class: 'locatable', title: 'Voir sur la carte', onclick: () => focusOn(p) } : {},
                h('span.dot', { style: `background:${s.color}` }),
                h('span', h('strong', p.name), ` · ${p.post_number ? `poste ${p.post_number}` : ROLE_SHORT[p.role]}`),
                h('span.small.muted', `${s.label}${p.lon !== null && p.status !== 'non_partage' ? ` · ${formatAge(p.age_s)}` : ''}${p.distance_m !== null && p.status === 'en_route' ? ` · à ${formatDistance(p.distance_m)}` : ''}`));
            })),
            h('button', { onclick: fitEveryone }, 'Voir tout le monde sur la carte'),
            shared.length < others.length ? h('p.small.muted', 'Seuls les participants qui ont accepté le partage apparaissent sur la carte.') : null,
          ];
        })()
      : null;

    fill(el,
      h('h3', '📍 Positions en direct'),
      watchId === null
        ? h('button', { onclick: startWatch }, 'Afficher ma position sur la carte')
        : null,
      geoError ? h('p.error.small', geoError) : null,
      mine,
      share,
      canShare()
        ? h('p.small.muted', sharing
            ? 'Partage actif : gardez l’application ouverte, écran allumé. Il s’arrête si vous fermez l’application ou verrouillez le téléphone.'
            : 'Votre position reste sur votre téléphone tant que vous ne la partagez pas. Seuls le président et les responsables voient les positions partagées ; elles sont effacées automatiquement.')
        : null,
      list);
  }

  function start() {
    if (active) return;
    active = true;
    poll();
    pollTimer = setInterval(() => document.visibilityState === 'visible' && poll(), canSeeAll ? 10_000 : 60_000);
    // À l'arrêt, le GPS ne produit pas toujours de nouvelle mesure : on renvoie la dernière.
    sendTimer = setInterval(refreshFix, MOVING_MS);
  }
  function stop() {
    active = false;
    clearInterval(pollTimer);
    clearInterval(sendTimer);
    othersLayer.clearLayers();
    others = [];
    sharing = false;
    stopWatch();
  }

  return {
    el,
    update(next) {
      sheet = next;
      if (running() && (canShare() || canSeeAll)) start();
      else if (active) stop();
      render();
    },
    destroy() {
      stop();
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
