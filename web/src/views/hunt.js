// Console d'une battue (président, responsable de battue) : convocations,
// réponses, rond du matin (présents, rôles, invités), postes du jour,
// attribution et tirage au sort, publication, début et fin de battue.
import L from '../map/leaflet.js';
import { addBasemaps } from '../map/basemap.js';
import { escapeHtml, toLatLng, ensureHatchPattern, postIcon } from '../map/shapes.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage, confirmDialog, copyText, modal } from '../ui.js';
import { STATUS_LABELS, ROLE_LABELS, CATEGORY_LABELS, COMMON_SPECIES, formatHuntDate, formatTime, huntLink, whatsappMessage, postedSummary } from '../lib/hunts.js';
import { watchRevision } from '../lib/live.js';
import { memberSheetView } from './sheet.js';

const MANAGERS = ['president', 'responsable'];

const TAB_KEY = 'chassestu.huntTab';

/**
 * Page d'une battue. Chasseur : vue chasseur. Président / responsable : deux
 * onglets, « Vue chasseur » (ce que voient les participants) et « Gestion ».
 */
export async function huntView(main, huntId) {
  if (!MANAGERS.includes(state.role)) {
    main.classList.remove('full'); // la fiche s'affiche en page normale, pas en console pleine largeur
    return memberSheetView(main, huntId);
  }
  let tab = 'gestion';
  try {
    tab = localStorage.getItem(TAB_KEY) === 'chasseur' ? 'chasseur' : 'gestion';
  } catch { /* préférence non mémorisée */ }
  const tabs = h('nav.hunt-tabs', { role: 'tablist' });
  const body = h('div.hunt-body');
  main.classList.add('with-tabs');
  main.append(tabs, body);
  let cleanup = null;

  async function show(next) {
    cleanup?.();
    cleanup = null;
    tab = next;
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* rien */ }
    fill(tabs,
      h('a', { role: 'tab', href: '#/battues', class: 'back' }, '←'),
      ...[['chasseur', '👁 Vue chasseur'], ['gestion', '⚙ Gestion']].map(([id, label]) =>
        h('button', { role: 'tab', 'aria-selected': String(tab === id), class: tab === id ? 'active' : '', onclick: () => tab !== id && show(id) }, label)));
    body.replaceChildren();
    body.className = `hunt-body ${tab}`;
    cleanup = tab === 'chasseur' ? await memberSheetView(body, huntId) : await consoleView(body, huntId);
  }
  await show(tab);
  return () => cleanup?.();
}

async function consoleView(main, huntId) {
  ensureHatchPattern();
  const hv = { detail: null, territory: null, members: [], allowDouble: false, placingMeeting: false };
  const box = h('div.hunt-console');
  const mapEl = h('div.hunt-map');
  main.append(h('div.hunt-layout', box, mapEl));
  let watcher = null;
  const map = L.map(mapEl, { zoomControl: true }).setView([46.6, 2.4], 6);
  addBasemaps(map);
  const layers = { base: L.featureGroup().addTo(map), posts: L.featureGroup().addTo(map) };
  let fitted = false;

  const link = () => huntLink(location.origin, huntId);

  async function act(fn, success) {
    try {
      const res = await fn();
      if (res?.hunt) hv.detail = res;
      await watcher?.sync(); // notre propre modification : pas de rechargement inutile
      if (success) toast(success);
      render();
      return res;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return null;
    }
  }

  async function load() {
    hv.detail = await api.get(`/hunts/${huntId}`);
    const [territory, members] = await Promise.all([
      api.get(`/territories/${hv.detail.hunt.territory_id}`),
      api.get('/members'),
    ]);
    hv.territory = territory;
    hv.members = members.members;
    render();
  }

  // -------------------------------------------------------------------------
  // Carte : postes du jour (vert), autres postes (gris) ; clic = ajouter/retirer
  // -------------------------------------------------------------------------

  function renderMap() {
    layers.base.clearLayers();
    layers.posts.clearLayers();
    const t = hv.territory;
    if (!t) return;
    const { hunt, day_post_ids, participants } = hv.detail;
    const tLayer = L.geoJSON(t.territory.geom, { style: { color: '#1f5130', weight: 3, fillOpacity: 0.04 }, interactive: false });
    layers.base.addLayer(tLayer);
    if (t.exclusion?.geom) layers.base.addLayer(L.geoJSON(t.exclusion.geom, { style: { color: '#d9480f', weight: 1, fillOpacity: 1, className: 'exclusion-shape' }, interactive: false }));
    for (const r of t.reserves) layers.base.addLayer(L.geoJSON(r.geom, { style: { color: '#c92a2a', weight: 1, fillOpacity: 1, className: 'reserve-shape' }, interactive: false }));
    if (hunt.meeting_point) layers.base.addLayer(L.circleMarker(toLatLng(hunt.meeting_point.coordinates), { radius: 8, color: '#0b6bcb', fillOpacity: 0.9 }).bindTooltip('Rendez-vous'));
    const day = new Set(day_post_ids);
    const occupants = new Map();
    for (const p of participants) if (p.post_id) occupants.set(p.post_id, [...(occupants.get(p.post_id) ?? []), p.name]);
    for (const p of t.posts) {
      const available = p.active && !p.invalid_reason;
      const cls = day.has(p.id) ? 'in-plan' : available ? 'dim' : 'invalid-static dim';
      const m = L.marker(toLatLng(p.geom.coordinates), { icon: postIcon(p.number, cls) });
      m.bindTooltip(escapeHtml(`Poste ${p.number}${p.name ? ` · ${p.name}` : ''}${occupants.get(p.id) ? ` — ${occupants.get(p.id).join(', ')}` : ''}${!available ? ' (indisponible)' : ''}`), { direction: 'top', offset: [0, -14] });
      if (hunt.status === 'en_cours') m.on('click', () => toggleDayPost(p, available));
      layers.posts.addLayer(m);
    }
    if (!fitted) {
      fitted = true;
      map.fitBounds(tLayer.getBounds(), { padding: [20, 20] });
    }
  }

  function toggleDayPost(p, available) {
    const day = new Set(hv.detail.day_post_ids);
    if (day.has(p.id)) day.delete(p.id);
    else if (available) day.add(p.id);
    else return toast(`Poste ${p.number} indisponible.`, 'error');
    act(() => api.put(`/hunts/${huntId}/posts`, { post_ids: [...day] }));
  }

  map.on('click', (e) => {
    if (!hv.placingMeeting) return;
    hv.placingMeeting = false;
    act(() => api.patch(`/hunts/${huntId}`, { meeting_point: { type: 'Point', coordinates: [e.latlng.lng, e.latlng.lat] } }), 'Point de rendez-vous enregistré.');
  });

  // -------------------------------------------------------------------------
  // Panneau
  // -------------------------------------------------------------------------

  function shareButton(kind, label = 'Copier le message pour WhatsApp') {
    return h('button', { onclick: () => copyText(whatsappMessage(kind, hv.detail.hunt, link())) }, label);
  }

  function infoSection() {
    const { hunt } = hv.detail;
    const editable = ['brouillon', 'publiee', 'en_cours'].includes(hunt.status);
    const field = (name, label, attrs, tag = 'input') => {
      const el = h(tag, { name, ...attrs, disabled: !editable });
      el.value = hunt[name] ?? '';
      el.addEventListener('change', () => act(() => api.patch(`/hunts/${huntId}`, { [name]: el.value }), 'Enregistré.'));
      return h('label', label, el);
    };
    return h(
      'details.card',
      { open: hunt.status === 'brouillon' },
      h('summary', 'Rendez-vous et consignes'),
      h('div.row', field('date', 'Date', { type: 'date' }), field('meeting_time', 'Heure', { type: 'time' })),
      field('meeting_place', 'Lieu', { maxlength: 200 }),
      field('briefing', 'Consignes', { rows: 3, maxlength: 5000 }, 'textarea'),
      editable ? h('button.link', { onclick: () => { hv.placingMeeting = true; toast('Cliquez sur la carte à l’endroit du rendez-vous.'); } }, hunt.meeting_point ? 'Déplacer le point de rendez-vous' : 'Placer le rendez-vous sur la carte') : null,
      speciesEditor(editable),
    );
  }

  /** Espèces chassables et quotas (vides = sans limite fixée). */
  function speciesEditor(editable) {
    const rows = hv.detail.species.map((x) => ({ ...x }));
    const list = h('div');
    const save = () => act(() => api.put(`/hunts/${huntId}/species`, { species: rows.filter((r) => r.species.trim()) }), 'Espèces enregistrées.');
    const draw = () => fill(list, rows.length
      ? h('table.list.compact', h('tbody', rows.map((r, i) => h('tr',
          h('td', r.species),
          h('td', h('input', { type: 'number', min: 0, max: 999, placeholder: 'sans limite', value: r.quota ?? '', disabled: !editable, 'aria-label': `Quota ${r.species}`,
            onchange: (e) => { r.quota = e.target.value === '' ? null : Number(e.target.value); save(); } })),
          editable ? h('td', h('button.link.danger', { onclick: () => { rows.splice(i, 1); save(); } }, '✕')) : null))))
      : h('p.small.muted', 'Aucune espèce précisée.'));
    draw();
    const name = h('input', { list: 'species-list', placeholder: 'Espèce (ex. Sanglier)', maxlength: 60 });
    const quota = h('input', { type: 'number', min: 0, max: 999, placeholder: 'quota' });
    return h('div.species-editor',
      h('h3', 'Espèces chassées et quotas'),
      list,
      editable ? h('form.row', { onsubmit: (e) => {
        e.preventDefault();
        if (!name.value.trim()) return;
        rows.push({ species: name.value.trim(), quota: quota.value === '' ? null : Number(quota.value) });
        save();
      } }, name, quota, h('button', { type: 'submit' }, 'Ajouter'),
      h('datalist', { id: 'species-list' }, COMMON_SPECIES.map((x) => h('option', { value: x })))) : null,
    );
  }

  /** Prélèvements du jour : saisie pour un participant (invité, chasseur sans téléphone). */
  function harvestSection() {
    const { participants, harvests, species } = hv.detail;
    const shooter = h('select', { 'aria-label': 'Tireur' }, h('option', { value: '' }, '— tireur —'),
      participants.filter((p) => p.present).map((p) => h('option', { value: p.id }, p.name)));
    const sp = h('select', { 'aria-label': 'Espèce' }, [...new Set([...species.map((x) => x.species), ...COMMON_SPECIES])].map((x) => h('option', { value: x }, x)));
    const cat = h('select', { 'aria-label': 'Catégorie' }, Object.entries(CATEGORY_LABELS).map(([v, l]) => h('option', { value: v, selected: v === 'indetermine' }, l)));
    return h('section.card',
      h('h2', `Prélèvements (${harvests.length})`),
      harvests.length ? h('ul.plain', harvests.map((x) => h('li',
        `${x.species} ${CATEGORY_LABELS[x.category]}${x.shooter ? ` — ${x.shooter}` : ''} · ${new Date(x.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} `,
        h('button.link.danger', { onclick: () => act(() => api.del(`/hunts/${huntId}/harvests/${x.id}`).then(() => api.get(`/hunts/${huntId}`))) }, 'Supprimer')))) : null,
      h('form.row', { onsubmit: (e) => {
        e.preventDefault();
        act(() => api.post(`/hunts/${huntId}/harvests`, { species: sp.value, category: cat.value, participant_id: shooter.value || null }).then(() => api.get(`/hunts/${huntId}`)), 'Prélèvement enregistré.');
      } }, shooter, sp, cat, h('button', { type: 'submit' }, 'Ajouter')),
    );
  }

  function convocationSection() {
    const { hunt, participants } = hv.detail;
    const convoked = new Map(participants.filter((p) => !p.guest).map((p) => [p.user_id, p]));
    const editable = ['brouillon', 'publiee', 'en_cours'].includes(hunt.status);
    const icon = (p) => (!p ? '' : p.response === 'present' ? '✅' : p.response === 'absent' ? '❌' : '…');
    const counts = { present: 0, absent: 0, none: 0 };
    for (const p of convoked.values()) counts[p.response ?? 'none'] += 1;
    return h(
      'details.card',
      { open: hunt.status !== 'en_cours' },
      h('summary', `Convocations (${convoked.size})`, hunt.status !== 'brouillon' ? ` · ✅ ${counts.present} · ❌ ${counts.absent} · … ${counts.none}` : ''),
      h('ul.plain.members', hv.members.map((m) =>
        h('li', h('label.check',
          h('input', {
            type: 'checkbox',
            checked: convoked.has(m.id),
            disabled: !editable,
            onchange: (e) => {
              const ids = new Set(convoked.keys());
              if (e.target.checked) ids.add(m.id);
              else ids.delete(m.id);
              act(() => api.put(`/hunts/${huntId}/convocations`, { user_ids: [...ids] }));
            },
          }),
          `${icon(convoked.get(m.id))} ${m.display_name || m.email || 'Membre'}`,
        )),
      )),
    );
  }

  function actionsSection() {
    const { hunt } = hv.detail;
    const go = (action, msg, confirmText) => async () => {
      if (confirmText && !(await confirmDialog(STATUS_LABELS[hunt.status], confirmText, 'Confirmer'))) return;
      // Les chasseurs sont prévenus automatiquement (alerte + notification) :
      // plus de message à copier. Le bouton WhatsApp reste en dépannage.
      const notifies = ['publier', 'debut', 'fin'].includes(action) || (action === 'annuler' && hunt.status === 'publiee');
      await act(() => api.post(`/hunts/${huntId}/actions/${action}`), notifies ? `${msg} Les chasseurs sont prévenus dans l’application.` : msg);
    };
    const buttons = {
      brouillon: [h('button.primary', { onclick: go('publier', 'Battue publiée.') }, 'Publier la battue'),
        h('button.danger', { onclick: async () => {
          if (!(await confirmDialog('Supprimer', 'Supprimer ce brouillon de battue ?', 'Supprimer', true))) return;
          try { await api.del(`/hunts/${huntId}`); location.hash = '#/battues'; } catch (err) { toast(errorMessage(err), 'error'); }
        } }, 'Supprimer')],
      publiee: [h('button.primary', { onclick: go('demarrer', 'Rond du matin : cochez les présents.') }, 'Démarrer (rond du matin)'),
        shareButton('convocation', 'Message WhatsApp (dépannage)'),
        h('button', { onclick: go('brouillon') }, 'Repasser en brouillon'),
        h('button.danger', { onclick: go('annuler', 'Battue annulée.', 'Annuler la battue ? Les convoqués devront être prévenus.') }, 'Annuler la battue')],
      en_cours: [
        !hunt.started_at
          ? h('button.primary', { onclick: go('debut', 'Début de battue.'), disabled: !hunt.assignments_published_at, title: hunt.assignments_published_at ? '' : 'Publiez d’abord les attributions' }, 'Début de battue')
          : h('span.status.status-en_cours', `Battue commencée à ${new Date(hunt.started_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`),
        h('button.danger', { onclick: go('fin', 'Battue terminée.', 'Terminer la battue ? Les liens invités cesseront de fonctionner.') }, 'Fin de battue')],
    }[hunt.status] ?? [];
    return h('div.buttons', buttons);
  }

  function morningSection() {
    const { participants, proposal, day_post_ids, hunt } = hv.detail;
    const { posted, unassigned } = postedSummary(participants);
    const guestName = h('input', { placeholder: 'Nom de l’invité', maxlength: 120 });
    const postsById = new Map(hv.territory.posts.map((p) => [p.id, p]));
    const dayPosts = day_post_ids.map((id) => postsById.get(id)).filter(Boolean).sort((a, b) => a.number - b.number);
    const postedPeople = participants.filter((p) => p.present && p.role === 'poste');
    const sameAsProposal = proposal && proposal.post_ids.length === day_post_ids.length && proposal.post_ids.every((id) => day_post_ids.includes(id));

    return [
      h('section.card',
        h('h2', `1. Présents · ${posted} posté(s)`),
        h('table.list.compact', h('tbody', participants.map((p) =>
          h('tr',
            h('td', h('input', { type: 'checkbox', checked: p.present, 'aria-label': `Présent : ${p.name}`, onchange: (e) => act(() => api.patch(`/hunts/${huntId}/participants/${p.id}`, { present: e.target.checked })) })),
            h('td', p.name, p.guest ? h('span.badge', 'invité') : null, p.response === 'absent' ? h('span.small.muted', ' (annoncé absent)') : null),
            h('td', h('select', { 'aria-label': `Rôle de ${p.name}`, onchange: (e) => act(() => api.patch(`/hunts/${huntId}/participants/${p.id}`, { role: e.target.value })) },
              Object.entries(ROLE_LABELS).map(([v, l]) => h('option', { value: v, selected: v === p.role }, l)))),
            p.guest ? h('td', h('button.link.danger', { onclick: () => act(() => api.del(`/hunts/${huntId}/participants/${p.id}`)) }, '✕')) : h('td'),
          )))),
        h('form.row', { onsubmit: (e) => { e.preventDefault(); if (guestName.value.trim()) act(() => api.post(`/hunts/${huntId}/guests`, { name: guestName.value.trim() }), 'Invité ajouté.'); } },
          guestName, h('button', { type: 'submit' }, 'Ajouter un invité')),
      ),
      h('section.card',
        h('h2', `2. Postes du jour · ${dayPosts.length} pour ${posted} posté(s)`),
        proposal ? h(`p.alert.${['plan', 'none'].includes(proposal.kind) ? 'muted' : proposal.kind === 'too_many' ? 'danger' : 'warn'}`, proposal.message) : null,
        proposal?.post_ids.length && !sameAsProposal
          ? h('button', { onclick: () => act(() => api.put(`/hunts/${huntId}/posts`, { post_ids: proposal.post_ids }), 'Proposition appliquée.') }, `Utiliser la proposition (${proposal.post_ids.length} poste(s))`)
          : null,
        h('p.small.muted', 'Cliquez sur un poste de la carte pour l’ajouter ou le retirer (le plan enregistré n’est pas modifié).'),
      ),
      h('section.card',
        h('h2', '3. Attribution'),
        dayPosts.length
          ? h('table.list.compact', h('tbody', dayPosts.map((post) => {
              const holders = participants.filter((p) => p.post_id === post.id);
              const cell = (holder, slot) => h('select', {
                'aria-label': `Poste ${post.number}${slot ? ' (doublon)' : ''}`,
                onchange: (e) => {
                  const pid = e.target.value;
                  if (!pid) return holder && act(() => api.del(`/hunts/${huntId}/assignments/${holder.id}`));
                  act(() => api.put(`/hunts/${huntId}/assignments`, { participant_id: pid, post_id: post.id, locked: holder?.locked ?? false }));
                },
              },
              h('option', { value: '' }, slot ? '+ doublon' : '— libre —'),
              postedPeople.filter((p) => !p.post_id || p.id === holder?.id).map((p) => h('option', { value: p.id, selected: p.id === holder?.id }, p.name)));
              return h('tr',
                h('th', `${post.number}${post.name ? ` · ${post.name}` : ''}`),
                h('td', cell(holders[0], 0), holders[0] ? h('label.check.small', h('input', {
                  type: 'checkbox', checked: holders[0].locked, title: 'Verrouillé : conservé par le tirage au sort',
                  onchange: (e) => act(() => api.put(`/hunts/${huntId}/assignments`, { participant_id: holders[0].id, post_id: post.id, locked: e.target.checked })),
                }), '🔒') : null),
                h('td', holders[0] && (holders[1] || proposal?.kind === 'too_many' || unassigned.length > 0) ? cell(holders[1], 1) : null),
              );
            })))
          : h('p.muted', 'Choisissez d’abord les postes du jour.'),
        dayPosts.length
          ? h('div.row',
              h('button', { onclick: async () => {
                const res = await act(() => api.post(`/hunts/${huntId}/draw`, { allow_double: hv.allowDouble }), 'Tirage au sort effectué (postes verrouillés conservés).');
                if (res?.unplaced) toast(`${res.unplaced} chasseur(s) sans poste : passez-les en traque ou autorisez les doublons.`, 'warn');
              } }, '🎲 Tirer au sort'),
              proposal?.kind === 'too_many' ? h('label.check', h('input', { type: 'checkbox', checked: hv.allowDouble, onchange: (e) => { hv.allowDouble = e.target.checked; } }), 'Autoriser les doublons') : null,
            )
          : null,
        unassigned.length ? h('p.alert.warn', `Sans poste : ${unassigned.map((p) => p.name).join(', ')}.`) : null,
        h('div.row',
          h('button.primary', { disabled: !dayPosts.length, onclick: publishAssignments }, hunt.assignments_published_at ? 'Republier les attributions' : 'Publier les attributions'),
          hunt.assignments_published_at ? shareButton('attributions', 'Message WhatsApp (dépannage)') : null,
        ),
        hunt.assignments_published_at ? h('p.small.muted', `Publiées à ${new Date(hunt.assignments_published_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} : chaque chasseur voit son poste.`) : null,
        guestLinksSection(),
      ),
    ];
  }

  async function publishAssignments() {
    const { unassigned } = postedSummary(hv.detail.participants);
    if (unassigned.length && !(await confirmDialog('Chasseurs sans poste', `${unassigned.map((p) => p.name).join(', ')} n’ont pas de poste. Publier quand même ?`, 'Publier'))) return;
    const res = await act(() => api.post(`/hunts/${huntId}/publish-assignments`));
    if (!res) return;
    toast(`Attributions publiées : ${res.notified} chasseur(s) prévenu(s) dans l’application.`);
    // Les invités sans compte ne reçoivent pas d'alerte : leur lien reste à envoyer.
    if (res.guest_links.length) {
      await modal('Liens des invités', [
        h('p', 'Les invités sans compte ne reçoivent pas d’alerte : envoyez à chacun son lien personnel (valable pour cette battue).'),
        res.guest_links.map((g) => h('div.row', h('span', g.name), h('button', { type: 'button', onclick: () => copyText(`${g.name}, voici votre poste pour la battue : ${g.url}`) }, 'Copier le lien'))),
      ]);
    }
  }

  function guestLinksSection() {
    const guests = hv.detail.participants.filter((p) => p.guest);
    if (!guests.length || !hv.detail.hunt.assignments_published_at) return null;
    return h('div',
      h('h3', 'Liens invités'),
      h('ul.plain', guests.map((g) => h('li', `${g.name} : ${g.has_guest_link ? 'lien envoyé' : 'pas de lien'} `,
        h('button.link', { onclick: async () => {
          try {
            const r = await api.post(`/hunts/${huntId}/participants/${g.id}/guest-link`);
            await copyText(`${g.name}, voici votre poste pour la battue : ${r.url}`);
            toast('Nouveau lien copié (l’ancien ne fonctionne plus).');
            await load();
          } catch (err) { toast(errorMessage(err), 'error'); }
        } }, g.has_guest_link ? 'Nouveau lien' : 'Créer un lien'),
        g.has_guest_link ? h('button.link.danger', { onclick: () => act(async () => { await api.del(`/hunts/${huntId}/participants/${g.id}/guest-link`); return api.get(`/hunts/${huntId}`); }, 'Lien révoqué.') }, ' Révoquer') : null,
      ))),
    );
  }

  function render() {
    const { hunt, participants } = hv.detail;
    const mine = participants.find((p) => p.user_id === state.user.id);
    fill(
      box,
      h('h1', `${formatHuntDate(hunt.date)} · ${hunt.territory_name}`),
      h('p', `Rendez-vous à ${formatTime(hunt.meeting_time)}${hunt.meeting_place ? `, ${hunt.meeting_place}` : ''} · `, h('span.status', { class: `status-${hunt.status}` }, STATUS_LABELS[hunt.status])),
      actionsSection(),
      hunt.status === 'en_cours' ? morningSection() : null,
      infoSection(),
      convocationSection(),
      ['en_cours', 'terminee'].includes(hunt.status) ? harvestSection() : null,
      mine && hunt.status !== 'brouillon' ? h('p.small.muted', 'Vous êtes convoqué : votre poste et vos consignes sont dans l’onglet « Vue chasseur ».') : null,
    );
    renderMap();
  }

  try {
    await load();
  } catch (err) {
    fill(box, h('p.error', errorMessage(err)));
  }
  setTimeout(() => map.invalidateSize(), 0);
  // Mise à jour automatique (réponses des chasseurs, prélèvements, autre responsable…).
  watcher = watchRevision(() => api.get(`/hunts/${huntId}/revision`), async () => {
    if (box.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return false;
    hv.detail = await api.get(`/hunts/${huntId}`);
    render();
    return true;
  });
  return () => {
    watcher.stop();
    map.remove();
  };
}
