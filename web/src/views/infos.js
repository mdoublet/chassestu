// Onglet « Infos » : dates d'ouverture, espèces chassables et règles de la
// saison (données de l'association), en trois vues : Ce jour, Saison, Règles.
// Reprise de la page d'informations de l'ACCA de Fontcouverte, rendue à
// partir des données de la saison (modifiables dans Paramètres).
import { h, fill } from '../ui.js';
import {
  addDays, daysBetween, dow, fmtDayMonth, fmtLong, fmtMid, fmtMin, fmtShort, JOURS, holidayName, sunTimes, resolveHours,
  windowsText, speciesStatus, nextOpenDate, firstFrom, lastTo, battueOn, nextBattue, dayNotices, hoursOf, todayISO,
} from '../lib/regulations.js';

const CHECK_KEY = 'chassestu.infosChecks';
const uniq = (a) => [...new Set(a)];
const pct = (m) => Math.max(0, Math.min(100, (m - 240) / 12)); // 4h → 24h
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

/** Texte des règles : paragraphes, listes « - », **gras** ; jamais de HTML. */
export function richText(text) {
  const inline = (s) => s.split(/(\*\*[^*]+\*\*)/).map((part) => (/^\*\*[^*]+\*\*$/.test(part) ? h('b', part.slice(2, -2)) : part));
  return String(text ?? '').split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n').filter((l) => l.trim());
    if (lines.length && lines.every((l) => /^\s*- /.test(l))) return h('ul', lines.map((l) => h('li', inline(l.replace(/^\s*- /, '')))));
    return h('p', inline(lines.join(' ')));
  });
}

export function renderInfos(root, reg) {
  const st = { date: todayISO(), tab: 'jour', cat: 'all', open: {}, auto: true };
  const view = h('div.infos-view');
  const dayLbl = h('span.dp-day');
  const dateLbl = h('span.dp-date');
  const todayTag = h('span.tag-today', 'aujourd’hui');
  const todayBtn = h('button.pill', { type: 'button', onclick: () => setDate(todayISO()) }, 'Revenir à aujourd’hui');
  const input = h('input', { type: 'date', 'aria-label': 'Choisir une date', onchange: (e) => e.target.value && setDate(e.target.value) });
  const tabsEl = h('nav.infos-tabs', { 'aria-label': 'Infos' });
  root.append(h('div.infos',
    h('header.infos-top',
      h('div.infos-brand', reg.title ?? ''),
      h('div.datebar',
        h('button.step', { type: 'button', 'aria-label': 'Jour précédent', onclick: () => setDate(addDays(st.date, -1)) }, '‹'),
        h('div.datepick', dayLbl, dateLbl, todayTag, todayBtn, input),
        h('button.step', { type: 'button', 'aria-label': 'Jour suivant', onclick: () => setDate(addDays(st.date, 1)) }, '›')),
      tabsEl),
    view));

  function setDate(d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    st.date = d;
    st.auto = d === todayISO();
    render();
  }
  function setTab(t) { st.tab = t; render(); root.scrollTop = 0; }

  function render() {
    const s = st.date;
    const hol = holidayName(s);
    const isToday = s === todayISO();
    dayLbl.textContent = JOURS[dow(s)] + (hol ? ` (${hol})` : '');
    dateLbl.textContent = fmtMid(s);
    input.value = s;
    todayBtn.hidden = isToday;
    todayTag.hidden = !isToday;
    fill(tabsEl, [['jour', '☀ Ce jour'], ['saison', '☰ Saison'], ['regles', '📘 Règles']].map(([k, l]) =>
      h('button', { type: 'button', 'aria-current': st.tab === k ? 'page' : null, onclick: () => setTab(k) }, l)));
    fill(view, st.tab === 'jour' ? renderDay() : st.tab === 'saison' ? renderSeason() : renderRules());
  }

  // ------------------------------------------------------------------ Ce jour
  const ctx = () => ({ s: st.date, sun: sunTimes(st.date, reg.reference), isToday: st.date === todayISO(), now: nowMin() });
  const catLabel = (id) => reg.categories.find((c) => c.id === id)?.label ?? id;

  function minibar(w, c) {
    return h('span.mb', { 'aria-hidden': 'true' },
      w.map(([a, b]) => h('i', { style: `left:${pct(a)}%;width:${Math.max(1, pct(b) - pct(a))}%` })),
      c.isToday ? h('b', { style: `left:${pct(c.now)}%` }) : null);
  }
  function openBadge(w, c) {
    if (!c.isToday) return h('span.badge.b-open', 'Ouvert');
    const s = [...w].sort((a, b) => a[0] - b[0]);
    if (s.some(([a, b]) => c.now >= a && c.now < b)) return h('span.badge.b-now', 'En cours');
    const next = s.find(([a]) => a > c.now);
    return next ? h('span.badge.b-wait', `Dès ${fmtMin(next[0])}`) : h('span.badge.b-done', 'Terminé');
  }
  const periodLine = (p) => h('li', `${fmtShort(p.from)} au ${fmtShort(p.to)}${p.where ? ` (${p.where.toLowerCase()})` : ''} : ${(reg.days[p.days]?.label ?? p.days).toLowerCase()}, ${hoursOf(reg, p).label}${p.cond ? ` — ${p.cond}` : ''}`);

  function body(e, s) {
    const rows = [];
    const add = (dt, dd) => rows.push(h('dt', dt), h('dd', dd));
    if (e.kind) add('Situation', e.checkText ?? '');
    if (s.periods?.length) {
      add('Jours', uniq(s.periods.map((p) => reg.days[p.days]?.label ?? p.days)).join(' ; '));
      const cs = uniq(s.periods.filter((p) => p.restricted && p.cond).map((p) => p.cond));
      if (cs.length) add('Conditions', cs.map((x, i) => [i ? h('br') : null, x]));
    }
    if (e.plan) add('Plan de chasse', e.plan);
    if (e.limitFull) add('Limites (PMA)', e.limitFull);
    if (e.periods?.length) add('Calendrier de l’espèce', h('ul', e.periods.map(periodLine)));
    if (e.notes?.length) add('À noter', h('ul', e.notes.map((n) => h('li', n))));
    if (e.src) rows.push(h('dt', 'Source'), h('dd.src', e.src));
    return h('div.sp-body', h('dl', rows));
  }
  function card(e, s, badge, inner, mb = null) {
    const d = h('details.sp', { open: !!st.open[e.id] },
      h('summary',
        h('div.sp-top', h('div.sp-name', e.name, e.sub ? h('span.sp-sub', e.sub) : null), h('div.sp-r', badge, h('span.chev', { 'aria-hidden': 'true' }, '›'))),
        inner, mb),
      body(e, s));
    d.addEventListener('toggle', () => { st.open[e.id] = d.open; });
    return d;
  }
  function cardHuntable(e, s, c) {
    const items = s.periods.map((p) => ({ where: p.where, cond: p.restricted ? '' : p.cond, w: resolveHours(hoursOf(reg, p), c.sun) }));
    const all = items.flatMap((i) => i.w);
    const inner = items.map((i) => h('div.hrs', i.where ? h('span.w', i.where) : null, h('b', windowsText(i.w)), i.cond ? h('span.cd', i.cond) : null));
    if (s.state === 'cond') {
      const b = e.battue ? battueOn(reg, e.battue, c.s) : null;
      let badge;
      if (b) { badge = h('span.badge.b-battue', 'Battue'); inner.push(h('div.bt', `Battue ce jour, responsable ${b.leader}`)); }
      else if (e.noPlan) badge = h('span.badge.b-check', 'Pas au plan de chasse');
      else badge = h('span.badge.b-cond', 'Sur autorisation');
      if (!b && e.battue) { const nb = nextBattue(reg, e.battue, c.s); if (nb) inner.push(h('div.lim', `Prochaine battue : ${fmtDayMonth(nb.date)} (${nb.leader})`)); }
      if (e.limit) inner.push(h('div.lim', e.limit));
      return card(e, s, badge, inner);
    }
    if (e.limit) inner.push(h('div.lim', e.limit));
    return card(e, s, openBadge(all, c), inner, minibar(all, c));
  }
  function cardNotDay(e, s, c) {
    const days = uniq(s.periods.map((p) => reg.days[p.days]?.label ?? p.days)).join(' ; ');
    const nx = nextOpenDate(reg, e, c.s);
    return card(e, s, h('span.badge.b-closed', 'Pas ce jour'), [h('div.hrs', `Chassable : ${days.toLowerCase()}`), nx ? h('div.lim', `Prochain jour : ${fmtDayMonth(nx)}`) : null]);
  }
  function cardClosed(e, s, c) {
    const f = firstFrom(e);
    return card(e, s, h('span.badge.b-closed', 'Fermé'), h('div.lim', f && c.s < f ? `Ouvre le ${fmtLong(f)}` : `Fermé depuis le ${fmtMid(lastTo(e))}`));
  }
  function cardCheck(e, s) {
    return card(e, s, s.state === 'suspended' ? h('span.badge.b-closed', 'Suspendu') : h('span.badge.b-check', 'À vérifier'), h('div.lim', e.checkText ?? ''));
  }
  function listByCat(rows, fn, c) {
    return reg.categories.flatMap((cat) => {
      const r = rows.filter((x) => x.e.cat === cat.id);
      return r.length ? [h('h3.sub', cat.label), ...r.map((x) => fn(x.e, x.s, c))] : [];
    });
  }
  function hero(c, nOpen, nCond, condNames) {
    const closed = nOpen === 0 && nCond === 0;
    let title;
    let sub;
    if (nOpen > 0) { title = 'Chasse ouverte'; sub = `${nOpen} espèce${nOpen > 1 ? 's' : ''} chassable${nOpen > 1 ? 's' : ''}${nCond ? ', plus le grand gibier sous conditions' : ''}`; }
    else if (nCond > 0) { title = 'Grand gibier seulement'; sub = `${condNames} (plan de chasse, bracelet obligatoire)`; }
    else {
      title = 'Chasse fermée';
      const cp = reg.campaign ?? {};
      sub = cp.from && c.s < cp.from ? (cp.before_text || 'Avant la campagne') : cp.to && c.s > cp.to ? (cp.after_text || 'Après la campagne') : 'Aucune espèce chassable à cette date';
    }
    const a = c.sun.rise - 60;
    const b = c.sun.set + 60;
    const lr = Math.max(10, Math.min(90, pct(c.sun.rise)));
    const ls = Math.max(10, Math.min(90, pct(c.sun.set)));
    return h('section.hero', { class: closed ? 'closed' : '', 'aria-live': 'polite' },
      h('h2', title), h('p', sub),
      h('div.daybar', { role: 'img', 'aria-label': `Jour de chasse de ${fmtMin(a)} à ${fmtMin(b)}` },
        h('span.lbl', { style: `left:${lr}%` }, `lever ${fmtMin(c.sun.rise)}`),
        h('span.lbl', { style: `left:${ls}%` }, `coucher ${fmtMin(c.sun.set)}`),
        h('div.band', { style: `left:${pct(a)}%;width:${pct(b) - pct(a)}%` }),
        c.isToday ? h('div.now', { style: `left:${pct(c.now)}%` }) : null),
      h('div.axis', [6, 9, 12, 15, 18, 21].map((x) => h('span', { style: `left:${pct(x * 60)}%` }, `${x}h`))),
      h('p.win', 'Jour de chasse (« de jour ») : ', h('b', `${fmtMin(a)} – ${fmtMin(b)}`),
        `, soit 1 h avant le lever et 1 h après le coucher du soleil${reg.reference?.name ? ` à ${reg.reference.name}` : ''}.`));
  }
  function renderDay() {
    const c = ctx();
    const res = reg.species.map((e) => ({ e, s: speciesStatus(reg, e, c.s) }));
    const by = (states) => res.filter((r) => states.includes(r.s.state));
    const open = by(['open']); const cond = by(['cond']); const notday = by(['notday']); const closed = by(['closed']); const checks = by(['check', 'suspended']);
    const condNames = cond.filter((r) => !r.e.noPlan).map((r) => r.e.name.toLowerCase()).join(' et ') || 'grand gibier';
    const vis = (r) => st.cat === 'all' || r.e.cat === st.cat;
    const o = open.filter(vis); const cd = cond.filter(vis); const nd = notday.filter(vis); const cl = closed.filter(vis); const ck = checks.filter(vis);
    const sec = (title, n) => h('h3.sec', title, h('small', String(n)));
    const chips = [['all', 'Tout'], ...reg.categories.map((x) => [x.id, x.label])];
    return [
      hero(c, open.length, cond.length, condNames),
      reg.day_hint || reg.checklist?.length ? h('p.hint', reg.day_hint ?? '', ' ', reg.checklist?.length ? h('button.linkbtn', { type: 'button', onclick: () => setTab('regles') }, 'Voir la liste de contrôle') : null) : null,
      dayNotices(reg, c.s).map((n) => h('div.note', { class: n.battue ? 'battue' : '' }, h('b', n.title), n.text)),
      h('div.chips', { role: 'group', 'aria-label': 'Filtrer par famille' }, chips.map(([k, l]) =>
        h('button.chip', { type: 'button', 'aria-pressed': String(st.cat === k), onclick: () => { st.cat = k; render(); } }, l))),
      o.length ? [sec('Chassable ce jour', o.length), listByCat(o, cardHuntable, c)] : null,
      cd.length ? [sec('Grand gibier et autorisations', cd.length), cd.map((r) => cardHuntable(r.e, r.s, c))] : null,
      nd.length ? [sec('Ouvert, mais pas ce jour', nd.length), listByCat(nd, cardNotDay, c)] : null,
      ck.length ? [sec('À vérifier ou suspendu', ck.length), ck.map((r) => cardCheck(r.e, r.s))] : null,
      cl.length ? h('details.group', h('summary', 'Fermé à cette date ', h('small', `(${cl.length})`)), listByCat(cl, cardClosed, c)) : null,
      !o.length && !cd.length && !nd.length && !ck.length && !cl.length ? h('p.hint', 'Aucune espèce dans cette famille.') : null,
      reg.day_footer ? h('p.foot', reg.day_footer) : null,
    ];
  }

  // ------------------------------------------------------------------ Saison
  function renderSeason() {
    const cp = reg.campaign ?? {};
    const D0 = reg.chart?.from ?? cp.from;
    const D1 = reg.chart?.to ?? cp.to;
    const SPAN = Math.max(1, daysBetween(D0, D1));
    const xp = (s) => Math.max(0, Math.min(100, (daysBetween(D0, s) / SPAN) * 100));
    const months = [];
    for (let d = `${D0.slice(0, 7)}-01`; d < D1; d = addDays(d, 32).slice(0, 7) + '-01') if (d > D0) months.push(d);
    const MC = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
    const s = st.date;
    const t = todayISO();
    const chart = h('div.chart',
      h('div.months', months.map((m) => h('span', { style: `left:${xp(m)}%` }, MC[+m.slice(5, 7) - 1]))),
      months.map((m) => h('div.mline', { style: `left:${xp(m)}%` })),
      reg.categories.flatMap((cat) => {
        const es = reg.species.filter((e) => e.cat === cat.id && e.periods?.length);
        if (!es.length) return [];
        return [h('h3.sub', cat.label), ...es.map((e) => {
          const lanes = uniq(e.periods.map((p) => p.where || ''));
          const lh = 14 / lanes.length;
          const track = h('div.track', { onclick: (ev) => {
            const r = chart.getBoundingClientRect();
            const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
            setDate(addDays(D0, Math.round(f * SPAN)));
          } },
            e.periods.filter((p) => !(p.to < D0 || p.from >= D1)).map((p) => {
              const l = xp(p.from);
              const rr = xp(addDays(p.to, 1));
              return h('i.seg', { class: p.restricted ? 'cond' : p.days !== 'ALL' ? 'limited' : '', style: `left:${l}%;width:${Math.max(0.6, rr - l)}%;top:${lanes.indexOf(p.where || '') * lh}px;height:${lh}px` });
            }),
            e.battue ? reg.battues.filter((b) => b.game === e.battue && b.date >= D0 && b.date <= D1).map((b) => h('u.tick', { style: `left:${xp(b.date)}%`, title: `Battue ${fmtShort(b.date)} (${b.leader})` })) : null);
          return h('div.crow', h('div.cname', e.name), track);
        })];
      }),
      t >= D0 && t <= D1 && t !== s ? h('div.mk.today', { style: `left:${xp(t)}%` }) : null,
      s >= D0 && s <= D1 ? [h('div.mk', { style: `left:${xp(s)}%` }), h('div.mk-lbl', { style: `left:${Math.max(8, Math.min(92, xp(s)))}%` }, fmtShort(s).replace(/ \d{4}$/, ''))] : null);
    return [
      h('h3.sec', `Saison ${reg.season_label ?? ''}`, h('small', 'touchez une barre pour choisir la date')),
      h('div.legend',
        h('span', h('i', { style: 'background:var(--i-open)' }), 'tous les jours'),
        h('span', h('i', { style: 'background:repeating-linear-gradient(135deg,var(--i-open) 0 3px,transparent 3px 6px);border:1px solid var(--i-open)' }), 'jours limités'),
        h('span', h('i', { style: 'border:2px solid var(--i-blaze)' }), 'sur autorisation'),
        h('span', h('i', { style: 'width:4px;background:var(--i-blaze)' }), 'battue')),
      chart,
      reg.season_footer ? h('p.foot', reg.season_footer) : null,
    ];
  }

  // ------------------------------------------------------------------ Règles
  function loadChecks() { try { return JSON.parse(localStorage.getItem(CHECK_KEY) || '{}'); } catch { return {}; } }
  function saveChecks(o) { try { localStorage.setItem(CHECK_KEY, JSON.stringify(o)); } catch { /* rien */ } }
  function renderRules() {
    const ck = loadChecks();
    return [
      h('h3.sec', 'Règles générales'),
      (reg.rules ?? []).map((r, i) => h('details.rule', { open: !!r.open },
        h('summary', r.title),
        h('div.rb', richText(r.text),
          // Liste de contrôle sous la première règle (« Avant de partir »).
          i === 0 && reg.checklist?.length ? reg.checklist.map((x) => h('label.check',
            h('input', { type: 'checkbox', checked: !!ck[x.id], onchange: (e) => { const o = loadChecks(); o[x.id] = e.target.checked; saveChecks(o); } }),
            h('span', x.label))) : null))),
    ];
  }

  render();
  // « En cours / Dès 14h » à jour : chaque minute, et au retour au premier plan.
  const timer = setInterval(() => { if (st.tab === 'jour' && st.date === todayISO()) render(); }, 60_000);
  const onVis = () => { if (!document.hidden && st.tab === 'jour') { if (st.auto) st.date = todayISO(); render(); } };
  document.addEventListener('visibilitychange', onVis);
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
}
