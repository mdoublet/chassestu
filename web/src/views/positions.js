// Guidage à pied et positions en direct (vue chasseur de la journée).
// - Guidage vers une cible : son poste (avant la battue) ou le point de
//   regroupement (après) : carte qui suit le chasseur, distance (le long du
//   chemin s'il existe), flèche orientée par la boussole, statut « Sur le
//   poste » (10 s dans le rayon), alerte vibrante en réserve ou en zone
//   d'exclusion, écran maintenu allumé, bouton « Je suis en place ».
// - Chacun peut afficher SA position (elle reste sur le téléphone).
// - Avec son accord (donné pour la journée), elle est envoyée au responsable
//   pendant les battues (15 s en mouvement, 60 s à l'arrêt ; la dernière seulement).
// - Président et responsables voient la position et le statut des participants.
// Les invités (lien sans compte) ont le guidage et « Je suis en place », sans partage.
import L from '../map/leaflet.js';
import { toLatLng, escapeHtml } from '../map/shapes.js';
import { api } from '../api.js';
import { h, fill, toast, errorMessage } from '../ui.js';
import { shouldSend, POSITION_STATUS, formatAge, formatDistance, MOVING_MS } from '../lib/geoloc.js';
import { pathProgress, bearing, headingFromOrientation, onPostStatus, zoneAt, ON_POST_HOLD_MS } from '../lib/guidance.js';

const ROLE_SHORT = { poste: 'posté', traqueur: 'traqueur', chef_de_ligne: 'chef de ligne' };
const ZONE_ALERT = {
  reserve: 'Vous êtes dans une réserve : aucune action de chasse.',
  exclusion: 'Vous êtes dans la zone de sécurité autour des habitations : aucun tir.',
};

/**
 * @param {L.Map} map
 * @param {{ dayId?: string, guestToken?: string, canSeeAll?: boolean, onChanged?: () => void }} opts
 * `update(ctx)` : { huntId, running, dayRunning, me, tolerance, reserves, exclusion, compact,
 *   target: null | { kind: 'post', number, name, coords, path, canConfirm } | { kind: 'point', title, coords } }
 */
export function positionPanel(map, { dayId, guestToken, canSeeAll = false, onChanged }) {
  const el = h('section.card.positions');
  const content = h('div');   // titre, alerte, flèche et distances
  // Pendant le guidage, la carte est déplacée ici, sous la flèche : tout tient sur un écran.
  const mapSlot = h('div.guide-map-slot');
  const below = h('div');     // boutons, partage, liste des participants
  el.append(content, mapSlot, below);
  const mapEl = map.getContainer();
  let mapHome = null;
  const arrow = h('div.guide-arrow', { 'aria-hidden': 'true' }, h('span', '➤'));
  const othersLayer = L.layerGroup().addTo(map);
  const meLayer = L.layerGroup().addTo(map);
  const isGuest = !!guestToken;
  let ctx = { target: null, running: false, dayRunning: false, me: null, tolerance: 30, reserves: [], exclusion: null, huntId: null, compact: false };
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
  let polledHunt = null;
  let centeredOnMe = false;
  let fittedOthers = false;
  let guiding = false;
  let follow = true;
  let heading = null;       // cap du téléphone (boussole), ou null
  let compassListening = false;
  let onPost = null;        // { status, since }
  let holdTimer = null;
  let zone = null;
  let busy = false;

  const canShare = () => !isGuest && !!ctx.me && !ctx.me.guest && ctx.dayRunning;
  const targetCoords = () => ctx.target?.coords ?? null;
  const targetKey = (t) => (t ? `${t.kind}:${t.number ?? ''}:${t.coords.join(',')}` : '');

  // --- Mesures GPS (téléphone) -------------------------------------------
  // Immobile, le téléphone peut ne plus donner de mesure : on réévalue la règle
  // des 10 s à l'échéance avec la dernière mesure.
  function evaluateOnPost() {
    const t = targetCoords();
    clearTimeout(holdTimer);
    if (!t || !fix) return;
    onPost = onPostStatus(onPost, { distance: pathProgress(null, [fix.lon, fix.lat], t).direct, accuracy: fix.accuracy, toleranceM: ctx.tolerance, now: Date.now() });
    if (onPost.status !== 'sur_poste' && onPost.since !== null) {
      holdTimer = setTimeout(() => {
        evaluateOnPost();
        render();
      }, Math.max(0, ON_POST_HOLD_MS - (Date.now() - onPost.since)) + 100);
    }
  }

  function onFix(p) {
    fix = { lon: p.coords.longitude, lat: p.coords.latitude, accuracy: Math.round(p.coords.accuracy), at: p.timestamp };
    geoError = null;
    evaluateOnPost();
    checkZone();
    drawMe();
    render();
    maybeSend();
  }

  function startWatch() {
    if (watchId !== null) return;
    if (!('geolocation' in navigator)) {
      geoError = 'Ce navigateur ne donne pas accès au GPS.';
      render();
      return;
    }
    geoError = null;
    watchId = navigator.geolocation.watchPosition(
      onFix,
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
    onPost = null;
    clearTimeout(holdTimer);
    zone = null;
    meLayer.clearLayers();
    releaseWakeLock();
  }

  function drawMe() {
    meLayer.clearLayers();
    if (!fix) return;
    const ll = [fix.lat, fix.lon];
    L.circle(ll, { radius: fix.accuracy, color: '#1c7ed6', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(meLayer);
    L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#1c7ed6', fillOpacity: 1 }).bindTooltip('Vous').addTo(meLayer);
    const t = targetCoords();
    if (guiding && follow) {
      if (!centeredOnMe) map.setView(ll, 17, { animate: false });
      else map.panTo(ll, { animate: true });
      centeredOnMe = true;
    } else if (!centeredOnMe) {
      centeredOnMe = true;
      map.fitBounds(L.latLngBounds([ll, ...(t ? [toLatLng(t)] : [])]).pad(0.3), { maxZoom: 17 });
    }
  }
  // L'utilisateur déplace la carte : on arrête de la recentrer sur lui.
  const onDrag = () => {
    if (guiding && follow) {
      follow = false;
      render();
    }
  };
  map.on('dragstart', onDrag);

  // --- Réserves et zone d'exclusion : alerte vibrante en entrant ---------
  function checkZone() {
    const next = fix ? zoneAt([fix.lon, fix.lat], { reserves: ctx.reserves ?? [], exclusion: ctx.exclusion ?? null }) : null;
    if (next && next !== zone) {
      try {
        navigator.vibrate?.([400, 150, 400, 150, 400]);
      } catch {
        /* pas de vibreur */
      }
      toast(ZONE_ALERT[next], 'warn');
    }
    zone = next;
  }

  // --- Boussole -------------------------------------------------------------
  const onOrientation = (e) => {
    const next = headingFromOrientation(e, screen.orientation?.angle ?? 0);
    if (next === null) return;
    heading = next;
    updateArrow();
  };
  function listenCompass() {
    if (compassListening) return;
    compassListening = true;
    // Android : cap absolu ; iPhone : webkitCompassHeading sur « deviceorientation ».
    window.addEventListener('deviceorientationabsolute', onOrientation);
    window.addEventListener('deviceorientation', onOrientation);
  }
  function stopCompass() {
    compassListening = false;
    window.removeEventListener('deviceorientationabsolute', onOrientation);
    window.removeEventListener('deviceorientation', onOrientation);
    heading = null;
  }
  const needsCompassPermission = () => typeof window.DeviceOrientationEvent?.requestPermission === 'function';
  let compassAllowed = !needsCompassPermission();
  async function askCompass() {
    try {
      compassAllowed = (await window.DeviceOrientationEvent.requestPermission()) === 'granted';
    } catch {
      compassAllowed = false;
    }
    if (compassAllowed) listenCompass();
    else toast('Boussole refusée : la flèche reste orientée nord en haut.', 'warn');
    render();
  }

  function updateArrow() {
    const t = targetCoords();
    if (!fix || !t) return;
    const b = bearing([fix.lon, fix.lat], t);
    arrow.style.transform = `rotate(${(heading === null ? b : b - heading) - 90}deg)`; // ➤ pointe vers l'est
  }

  // --- Guidage --------------------------------------------------------------
  function startGuiding() {
    guiding = true;
    follow = true;
    // Déplacer la carte AVANT de la centrer : sa taille change.
    if (!mapHome) {
      mapHome = { parent: mapEl.parentNode, next: mapEl.nextSibling };
      mapSlot.append(mapEl);
      mapEl.classList.add('guiding');
      map.invalidateSize({ pan: false });
    }
    centeredOnMe = false;
    startWatch();
    if (compassAllowed) listenCompass();
    acquireWakeLock();
    if (fix) drawMe();
    render();
    el.scrollIntoView({ block: 'start' });
  }
  function restoreMap() {
    if (!mapHome) return;
    mapHome.parent.insertBefore(mapEl, mapHome.next);
    mapEl.classList.remove('guiding');
    mapHome = null;
    map.invalidateSize();
  }
  function stopGuiding() {
    guiding = false;
    restoreMap();
    stopCompass();
    if (!sharing) stopWatch();
    else releaseWakeLockIfIdle();
    render();
  }

  async function setInPlace(value) {
    if (busy || !ctx.huntId) return;
    busy = true;
    try {
      if (isGuest) await api.put(`/guest/${guestToken}/in-place`, { in_place: value }, { tenant: false });
      else await api.put(`/hunts/${ctx.huntId}/in-place`, { in_place: value });
      toast(value ? 'Le responsable sait que vous êtes en place.' : 'Confirmation annulée.');
      if (ctx.me) ctx.me.in_place = value;
      onChanged?.();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      busy = false;
      render();
    }
  }

  // À l'arrêt, watchPosition peut ne plus rien produire : on redemande une
  // mesure fraîche plutôt que de renvoyer une ancienne (sinon « sans signal »).
  function refreshFix() {
    if (!sharing || watchId === null || document.visibilityState !== 'visible') return;
    if (fix && Date.now() - fix.at < 50_000) return maybeSend();
    navigator.geolocation.getCurrentPosition(onFix, () => {}, { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 });
  }

  // --- Envoi au serveur (si accord, pendant une battue) -------------------
  async function maybeSend(force = false) {
    if (!sharing || !ctx.running || !ctx.huntId || !fix || sending) return;
    if (!force && !shouldSend(lastSent, fix)) return;
    sending = true;
    try {
      await api.post(`/hunts/${ctx.huntId}/position`, { lon: fix.lon, lat: fix.lat, accuracy: fix.accuracy, recorded_at: new Date(fix.at).toISOString() });
      lastSent = { lon: fix.lon, lat: fix.lat, sentAt: Date.now() };
    } catch (err) {
      // Accord retiré : on arrête ; battue finie ou réseau absent : rien à faire.
      if (err.status === 403) {
        sharing = false;
        render();
      }
    } finally {
      sending = false;
    }
  }

  async function setSharing(share) {
    try {
      await api.put(`/days/${dayId}/position-sharing`, { share });
      sharing = share;
      lastSent = null;
      if (share) {
        startWatch();
        acquireWakeLock();
        maybeSend(true);
        toast('Position partagée avec le responsable pendant les battues de la journée.');
      } else {
        releaseWakeLockIfIdle();
        toast('Partage arrêté ; votre position a été effacée.');
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    render();
  }

  // Écran allumé pendant le guidage ou le partage (le GPS s'arrête écran verrouillé).
  async function acquireWakeLock() {
    try {
      if ((sharing || guiding) && !wakeLock && document.visibilityState === 'visible') {
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
  function releaseWakeLockIfIdle() {
    if (!sharing && !guiding) releaseWakeLock();
  }
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    acquireWakeLock();
    maybeSend(true);
    poll();
  };
  document.addEventListener('visibilitychange', onVisible);

  // --- Positions des participants (responsables) ----------------------------
  async function poll() {
    if (isGuest || !canSeeAll || !ctx.running || !ctx.huntId) return;
    try {
      const res = await api.get(`/hunts/${ctx.huntId}/positions`);
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
    follow = false;
    map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 17 });
    map.getContainer().scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function focusOn(p) {
    follow = false;
    map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16));
    map.getContainer().scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function drawOthers() {
    othersLayer.clearLayers();
    if (!canSeeAll) return;
    if (!fittedOthers && !guiding && others.some((p) => p.lon !== null)) {
      fittedOthers = true;
      const pts = others.filter((p) => p.lon !== null).map((p) => [p.lat, p.lon]);
      const t = targetCoords();
      if (t) pts.push(toLatLng(t));
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
  function confirmBlock() {
    const t = ctx.target;
    if (t?.kind !== 'post' || !t.canConfirm) return null;
    return ctx.me?.in_place
      ? h('div.in-place.done', h('strong', '✅ Vous avez confirmé être en place'),
          h('button.link', { onclick: () => setInPlace(false), disabled: busy }, 'Annuler'))
      : h('button', { class: onPost?.status === 'sur_poste' ? 'primary in-place' : 'in-place', onclick: () => setInPlace(true), disabled: busy }, '✅ Je suis en place');
  }

  function guidanceBlock() {
    const t = ctx.target;
    const isPost = t.kind === 'post';
    const title = isPost ? `Poste n° ${t.number}${t.name ? ` · ${t.name}` : ''}` : t.title;
    const confirm = confirmBlock();
    if (!guiding) {
      return {
        top: [
          h('h3', isPost ? `🥾 ${ctx.compact ? 'Votre poste' : 'Rejoindre mon poste'} n° ${t.number}` : `🥾 ${t.title}`),
          h('div.buttons',
            h(ctx.compact ? 'button' : 'button.primary', { onclick: startGuiding }, isPost ? 'Démarrer le guidage à pied' : 'Me guider à pied'),
            confirm),
          !ctx.compact ? h('p.small.muted', isPost && t.path
            ? 'La carte vous suit, avec la distance restante le long du chemin et une flèche vers le poste.'
            : 'Le guidage indique la direction et la distance à vol d’oiseau.') : null,
        ],
        bottom: null,
      };
    }
    const here = fix ? [fix.lon, fix.lat] : null;
    const path = isPost ? t.path : null;
    const prog = here ? pathProgress(path, here, t.coords) : null;
    const st = POSITION_STATUS[onPost?.status ?? 'localise'];
    const reached = onPost?.status === 'sur_poste';
    const top = [
      h('h3', `🥾 ${title}`),
      zone ? h('p.alert.danger.zone-alert', `⚠ ${ZONE_ALERT[zone]}`) : null,
      geoError ? h('p.error.small', geoError) : null,
      !fix && !geoError ? h('p.small.muted', 'Recherche du signal GPS…') : null,
      fix
        ? h('div.guide', { class: reached ? 'reached' : '' },
            reached ? h('div.guide-arrow.done', '✓') : arrow,
            h('div.guide-text',
              h('p.guide-distance', reached ? (isPost ? 'Vous êtes sur votre poste' : 'Vous êtes arrivé') : path ? `${formatDistance(prog.remaining)} par le chemin` : `${formatDistance(prog.direct)} à vol d’oiseau`),
              !reached && path ? h('p', `${formatDistance(prog.direct)} à vol d’oiseau${prog.offPath > 25 ? ` · vous êtes à ${formatDistance(prog.offPath)} du chemin` : ''}`) : null,
              h('p.my-position', h('span.dot', { style: `background:${st.color}` }), h('strong', isPost || st !== POSITION_STATUS.sur_poste ? st.label : 'Arrivé'),
                h('span.small.muted', ` · précision ±${fix.accuracy} m`)),
              !reached ? h('p.small.muted', heading === null ? 'Flèche : nord en haut de l’écran.' : 'Flèche orientée selon votre téléphone.') : null))
        : null,
    ];
    const bottom = [
      h('div.buttons',
        confirm,
        !follow ? h('button', { onclick: () => { follow = true; centeredOnMe = true; if (fix) map.setView([fix.lat, fix.lon], Math.max(map.getZoom(), 16)); render(); } }, '⌖ Recentrer') : null,
        !compassAllowed && heading === null ? h('button', { onclick: askCompass }, '🧭 Activer la boussole') : null,
        h('button.link', { onclick: stopGuiding }, 'Arrêter le guidage')),
      h('p.small.muted', 'Gardez l’application ouverte : l’écran reste allumé pendant le guidage.'),
    ];
    queueMicrotask(updateArrow);
    return { top, bottom };
  }

  function render() {
    const showList = canSeeAll && ctx.running;
    if (!ctx.target && !canShare() && !showList) {
      fill(content);
      fill(below);
      el.hidden = true;
      return;
    }
    el.hidden = false;

    const share = canShare()
      ? [
          h('label.check.share',
            h('input', { type: 'checkbox', checked: sharing, onchange: (e) => setSharing(e.target.checked) }),
            'Partager ma position avec le responsable pendant les battues de la journée'),
          h('p.small.muted', sharing
            ? 'Partage actif : gardez l’application ouverte, écran allumé. Il s’arrête si vous fermez l’application ou verrouillez le téléphone.'
            : 'Votre position reste sur votre téléphone tant que vous ne la partagez pas. Seuls le président et les responsables voient les positions partagées ; elles sont effacées automatiquement.'),
        ]
      : null;

    // Sans cible (traqueur, chef de ligne, responsable) : simple affichage de sa position.
    const ownWithoutTarget = !ctx.target
      ? [
          h('h3', '📍 Positions en direct'),
          watchId === null ? h('button', { onclick: startWatch }, 'Afficher ma position sur la carte') : null,
          geoError ? h('p.error.small', geoError) : null,
          fix ? h('p.my-position', h('span.dot', { style: `background:${POSITION_STATUS.localise.color}` }), h('strong', 'Localisé'), h('span.small.muted', ` · précision ±${fix.accuracy} m`)) : null,
          zone ? h('p.alert.danger.zone-alert', `⚠ ${ZONE_ALERT[zone]}`) : null,
        ]
      : null;

    const list = showList && others.length
      ? (() => {
          const shared = others.filter((p) => p.shared);
          const ready = others.filter((p) => p.status === 'sur_poste' || p.status === 'confirme').length;
          const posted = others.filter((p) => p.post_number !== null).length;
          return [
            h('h3', `Participants · ${ready} en place / ${posted} poste(s) attribué(s)`),
            h('ul.plain.position-list', others.map((p) => {
              const s = POSITION_STATUS[p.status] ?? POSITION_STATUS.localise;
              return h('li', p.lon !== null ? { class: 'locatable', title: 'Voir sur la carte', onclick: () => focusOn(p) } : {},
                h('span.dot', { style: `background:${s.color}` }),
                h('span', h('strong', p.name), ` · ${p.post_number ? `poste ${p.post_number}` : ROLE_SHORT[p.role]}`),
                h('span.small.muted', `${s.label}${p.lon !== null && p.shared ? ` · position ${formatAge(p.age_s)}` : ''}${p.distance_m !== null && p.status === 'en_route' ? ` · à ${formatDistance(p.distance_m)}` : ''}`));
            })),
            h('button', { onclick: fitEveryone }, 'Voir tout le monde sur la carte'),
            shared.length < others.length ? h('p.small.muted', 'Seuls les participants qui ont accepté le partage apparaissent sur la carte.') : null,
          ];
        })()
      : null;

    const guide = ctx.target ? guidanceBlock() : { top: null, bottom: null };
    fill(content, guide.top, ownWithoutTarget);
    fill(below, guide.bottom, share, list);
  }

  function syncTimers() {
    const wantPoll = !isGuest && canSeeAll && ctx.running && ctx.huntId;
    if (wantPoll && polledHunt !== ctx.huntId) {
      clearInterval(pollTimer);
      polledHunt = ctx.huntId;
      fittedOthers = false;
      poll();
      pollTimer = setInterval(() => document.visibilityState === 'visible' && poll(), 10_000);
    } else if (!wantPoll && polledHunt) {
      clearInterval(pollTimer);
      polledHunt = null;
      others = [];
      othersLayer.clearLayers();
    }
    if (!sendTimer && !isGuest) sendTimer = setInterval(refreshFix, MOVING_MS);
  }

  return {
    el,
    update(next) {
      const changed = targetKey(next.target) !== targetKey(ctx.target);
      ctx = { ...ctx, ...next };
      if (changed) {
        onPost = null;
        centeredOnMe = false;
        evaluateOnPost();
      }
      if (next.sharing !== undefined && next.sharing !== sharing && canShare()) {
        sharing = next.sharing;
        if (sharing) {
          startWatch();
          acquireWakeLock();
        }
      }
      if (!ctx.dayRunning) {
        sharing = false;
        if (guiding) stopGuiding();
      }
      if (!ctx.target && guiding) stopGuiding();
      syncTimers();
      render();
    },
    destroy() {
      clearInterval(pollTimer);
      clearInterval(sendTimer);
      restoreMap();
      stopCompass();
      stopWatch();
      map.off('dragstart', onDrag);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
