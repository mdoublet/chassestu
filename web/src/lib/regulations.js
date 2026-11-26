// Infos de chasse d'une saison (sans DOM, testé) : jours fériés, lever et
// coucher du soleil, horaires, jours autorisés et état de chaque espèce à
// une date, d'après le « règlement » de l'association (données de la saison).

export const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
export const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MOIS_C = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

const pad = (n) => String(n).padStart(2, '0');
export const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const toDate = (s) => { const p = s.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)); };
const fromDate = (dt) => dt.toISOString().slice(0, 10);
export const addDays = (s, n) => { const dt = toDate(s); dt.setUTCDate(dt.getUTCDate() + n); return fromDate(dt); };
export const dow = (s) => toDate(s).getUTCDay(); // 0 = dimanche
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
const day1 = (d) => (d === 1 ? '1er' : d);
export const fmtLong = (s) => { const p = s.split('-').map(Number); return `${JOURS[dow(s)]} ${day1(p[2])} ${MOIS[p[1] - 1]} ${p[0]}`; };
export const fmtMid = (s) => { const p = s.split('-').map(Number); return `${day1(p[2])} ${MOIS[p[1] - 1]} ${p[0]}`; };
export const fmtShort = (s) => { const p = s.split('-').map(Number); return `${day1(p[2])} ${MOIS_C[p[1] - 1]} ${p[0]}`; };
export const fmtDayMonth = (s) => { const p = s.split('-').map(Number); return `${JOURS[dow(s)]} ${day1(p[2])} ${MOIS[p[1] - 1]}`; };
export const fmtMin = (m) => { m = Math.round(m); return `${Math.floor(m / 60)}h${pad(m % 60)}`; };
export const todayISO = (d = new Date()) => iso(d.getFullYear(), d.getMonth() + 1, d.getDate());

/** Dimanche de Pâques (algorithme de Meeus). */
export function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}

const holidayCache = new Map();
/** Jours fériés en France métropolitaine : { 'AAAA-MM-JJ': nom }. */
export function holidays(y) {
  if (!holidayCache.has(y)) {
    const e = easter(y);
    holidayCache.set(y, {
      [iso(y, 1, 1)]: 'Jour de l’An', [addDays(e, 1)]: 'Lundi de Pâques', [iso(y, 5, 1)]: 'Fête du Travail',
      [iso(y, 5, 8)]: 'Victoire 1945', [addDays(e, 39)]: 'Ascension', [addDays(e, 50)]: 'Lundi de Pentecôte',
      [iso(y, 7, 14)]: 'Fête nationale', [iso(y, 8, 15)]: 'Assomption', [iso(y, 11, 1)]: 'Toussaint',
      [iso(y, 11, 11)]: 'Armistice 1918', [iso(y, 12, 25)]: 'Noël',
    });
  }
  return holidayCache.get(y);
}
export const holidayName = (s) => holidays(+s.slice(0, 4))[s] ?? null;

let fmt = null;
function localMinutes(ms) {
  fmt ??= new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let h = 0, mi = 0;
  for (const x of fmt.formatToParts(new Date(ms))) { if (x.type === 'hour') h = +x.value; if (x.type === 'minute') mi = +x.value; }
  return h * 60 + mi;
}

/** Lever et coucher du soleil (minutes, heure de Paris) ; algorithme NOAA simplifié, ±2 min. */
export function sunTimes(s, { lat, lon }) {
  const [y, m, d] = s.split('-').map(Number);
  const N = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1, rad = Math.PI / 180;
  const g = (2 * Math.PI / 365) * (N - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosH = Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl);
  const H = Math.acos(Math.max(-1, Math.min(1, cosH))) / rad;
  const rise = 720 - 4 * (lon + H) - eq, set = 720 - 4 * (lon - H) - eq;
  const base = Date.UTC(y, m - 1, d);
  return { rise: localMinutes(base + rise * 60000), set: localMinutes(base + set * 60000) };
}

/** Borne d'horaire : « HH:MM », « r±min » (lever), « s±min » (coucher). */
export function parseBound(b, sun) {
  let m;
  if ((m = /^(\d\d):(\d\d)$/.exec(b))) return +m[1] * 60 + +m[2];
  if ((m = /^r([+-]\d+)$/.exec(b))) return sun.rise + +m[1];
  if ((m = /^s([+-]\d+)$/.exec(b))) return sun.set + +m[1];
  return 0;
}
export const resolveHours = (h, sun) => (h?.seg ?? []).map(([a, b]) => [parseBound(a, sun), parseBound(b, sun)]);
export const windowsText = (w) => w.map(([a, b]) => `${fmtMin(a)} – ${fmtMin(b)}`).join(' et ');

/** Jour autorisé selon la règle de jours (jours de la semaine, jours fériés). */
export function dayAllowed(reg, rule, s) {
  const r = reg.days?.[rule];
  if (!r) return false;
  return (r.dow ?? []).includes(dow(s)) || (!!r.holidays && !!holidayName(s));
}

export const battueOn = (reg, game, s) => { const b = (reg.battues ?? []).find((x) => x.game === game && x.date === s); return b ? { date: s, leader: b.leader } : null; };
export const nextBattue = (reg, game, s) => { const b = (reg.battues ?? []).filter((x) => x.game === game && x.date > s).sort((a, c) => a.date.localeCompare(c.date))[0]; return b ? { date: b.date, leader: b.leader } : null; };

/** État d'une espèce à une date : open | cond (sous conditions) | notday | closed | check | suspended. */
export function speciesStatus(reg, e, s) {
  if (e.kind === 'suspended') return { state: 'suspended' };
  if (e.kind === 'check') return { state: 'check' };
  const ps = (e.periods ?? []).filter((p) => s >= p.from && s <= p.to);
  if (!ps.length) return { state: 'closed' };
  const ok = ps.filter((p) => dayAllowed(reg, p.days, s));
  if (!ok.length) return { state: 'notday', periods: ps };
  const allRestricted = ok.every((p) => p.restricted);
  return { state: allRestricted ? 'cond' : 'open', periods: ok.filter((p) => allRestricted || !p.restricted) };
}
export const isHuntable = (st) => st.state === 'open' || st.state === 'cond';
export function nextOpenDate(reg, e, s, max = 430) {
  for (let i = 1; i <= max; i++) { const d = addDays(s, i); if (isHuntable(speciesStatus(reg, e, d))) return d; }
  return null;
}
export const firstFrom = (e) => (e.periods ?? []).reduce((m, p) => (!m || p.from < m ? p.from : m), null);
export const lastTo = (e) => (e.periods ?? []).reduce((m, p) => (!m || p.to > m ? p.to : m), null);
export const hoursOf = (reg, p) => reg.hours?.[p.hours] ?? { seg: [], label: '' };

/**
 * Avis du jour : hors campagne, avis datés de la saison, jour férié comptant
 * comme jour de chasse, battues ce jour. Renvoie [{ title, text, battue? }].
 */
export function dayNotices(reg, s) {
  const out = [];
  const c = reg.campaign ?? {};
  if ((c.from && s < c.from) || (c.to && s > c.to)) out.push({ title: 'Hors campagne', text: `Cette date n’est pas couverte par le règlement ${reg.season_label ?? ''}.`.replace(' .', '.') });
  for (const n of reg.notices ?? []) if (s >= n.from && s <= n.to) out.push({ title: n.title, text: n.text });
  const hol = holidayName(s);
  if (hol) {
    // Jour férié en semaine qui ouvre des espèces (règle de jours avec fériés, hors jours ordinaires).
    const names = (reg.species ?? []).filter((e) => (e.periods ?? []).some((p) => {
      const r = reg.days?.[p.days];
      return r?.holidays && !(r.dow ?? []).includes(dow(s)) && s >= p.from && s <= p.to;
    })).map((e) => e.name.toLowerCase());
    if (names.length) out.push({ title: `Jour férié : ${hol}`, text: `Il compte comme jour de chasse pour : ${[...new Set(names)].join(', ')}.` });
  }
  const games = [...new Set((reg.battues ?? []).filter((b) => b.date === s).map((b) => b.game))];
  for (const g of games) {
    const b = battueOn(reg, g, s);
    out.push({ title: `Battue au ${g} ce jour`, text: `Responsable : ${b.leader}.${reg.battue_notice ? ` ${reg.battue_notice}` : ''}`, battue: true });
  }
  return out;
}
