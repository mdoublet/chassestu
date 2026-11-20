import './style.css';
import { initAuth, isSignedIn, mountSignIn, signOut, onAuthChange } from './auth.js';
import { api } from './api.js';
import { state } from './state.js';
import { h, errorMessage, toast, ROLE_LABELS } from './ui.js';
import { APP_NAME, navItems, activeHref } from './lib/nav.js';
import { registerServiceWorker, refreshPushSubscription } from './push-client.js';
import { homeView } from './views/home.js';
import { membersView } from './views/members.js';
import { settingsView } from './views/settings.js';
import { adminView } from './views/admin.js';
import { invitationView, PENDING_INVITE_KEY } from './views/invitation.js';

const app = document.getElementById('app');

/** Garde-fou : un bloc conditionnel absent (null, undefined, false) n'est jamais écrit « null » dans la page. */
function safeAppend(el) {
  const append = el.append.bind(el);
  el.append = (...nodes) => append(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  return el;
}
let cleanup = null;

// Routes (hachage) : #/, #/journees, #/journees/<id>, #/carte, #/membres, #/parametres, #/admin, #/invitation/<jeton>
const routes = [
  { re: /^#\/invitation\/([A-Za-z0-9_-]+)$/, view: invitationView, public: true },
  { re: /^#\/territoires$/, view: (el) => import('./views/territories.js').then((m) => m.territoriesView(el)), tenant: true },
  { re: /^#\/carte(?:\/([0-9a-f-]{36}|nouveau))?$/, view: (el, start) => import('./views/editor.js').then((m) => m.editorView(el, start)), tenant: true, full: true },
  { re: /^#\/(?:journee|battue)-invite\/([A-Za-z0-9_-]+)$/, view: (el, token) => import('./views/day-sheet.js').then((m) => m.guestDayView(el, token)), public: true },
  { re: /^#\/(?:journees|battues)$/, view: (el) => import('./views/days.js').then((m) => m.daysView(el)), tenant: true },
  // Anciennes adresses de battue : la journée convertie garde le même identifiant.
  { re: /^#\/(?:journees|battues)\/([0-9a-f-]{36})(?:\/ma-fiche)?$/, view: (el, id) => import('./views/day.js').then((m) => m.dayView(el, id)), tenant: true, full: true },
  { re: /^#\/notifications$/, view: (el, opts) => import('./views/notifications.js').then((m) => m.notificationsView(el, opts)) },
  { re: /^#\/profil$/, view: (el, opts) => import('./views/profile.js').then((m) => m.profileView(el, opts)) },
  { re: /^#\/lieux$/, view: (el) => import('./views/places.js').then((m) => m.placesView(el)), tenant: true, roles: ['president'] },
  { re: /^#\/plans(?:\/([0-9a-f-]{36})(?:\/([0-9a-f-]{36}))?)?$/, view: (el, id, hp) => import('./views/plans.js').then((m) => m.plansView(el, id, hp)), tenant: true, roles: ['president', 'responsable'], full: true },
  { re: /^#\/membres$/, view: membersView, tenant: true, roles: ['president', 'responsable'] },
  { re: /^#\/parametres$/, view: settingsView, tenant: true, roles: ['president'] },
  { re: /^#\/admin$/, view: adminView },
  { re: /^#?\/?$/, view: homeView },
];

export async function refreshMe() {
  state.setMe(await api.get('/me', { tenant: false }));
  refreshPushSubscription();
  pollUnread();
}

// ---------------------------------------------------------------------------
// Cloche : nombre d'alertes non lues (mise à jour régulière et à chaque push)
// ---------------------------------------------------------------------------
let unread = 0;
async function pollUnread() {
  if (!state.user) return;
  try {
    ({ unread } = await api.get('/notifications/unread', { tenant: false }));
  } catch {
    return;
  }
  for (const el of document.querySelectorAll('.bell-count')) {
    el.textContent = unread > 9 ? '9+' : String(unread);
    el.hidden = unread === 0;
  }
  for (const el of document.querySelectorAll('.bell')) el.setAttribute('aria-label', `Alertes : ${unread} non lue(s)`);
}
setInterval(() => document.visibilityState === 'visible' && pollUnread(), 60_000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && pollUnread());
window.addEventListener('alerts-changed', pollUnread);

function header() {
  const tenantSelect =
    state.tenants.length > 1
      ? h(
          'select.tenant-select',
          {
            'aria-label': 'Association',
            onchange: (e) => {
              state.setTenant(e.target.value);
              location.hash = '#/';
              render();
            },
          },
          state.tenants.map((t) => h('option', { value: t.id, selected: t.id === state.tenantId }, t.name)),
        )
      : state.tenant
        ? h('span.tenant-name', state.tenant.name)
        : null;

  const items = state.user ? navItems({ role: state.role, isSuperAdmin: Boolean(state.user.is_super_admin), hasTenant: Boolean(state.tenant) }) : [];
  const active = activeHref(location.hash, items);
  const logout = state.user
    ? h('button.link.logout', {
        onclick: async () => {
          await signOut();
          location.hash = '#/';
          location.reload();
        },
      }, 'Déconnexion')
    : null;
  // Menu : en ligne sur grand écran ; bouton « Menu » dépliant sur téléphone.
  const nav = items.length
    ? h('nav.main-nav', { 'aria-label': 'Menu principal' },
        items.map((it) => h('a', { href: it.href, class: it.href === active ? 'active' : '', 'aria-current': it.href === active ? 'page' : null },
          h('span.nav-icon', { 'aria-hidden': 'true' }, it.icon), it.label)),
        logout,
      )
    : null;
  const bar = h(
    'header.topbar',
    h('a.brand', { href: '#/' }, APP_NAME),
    tenantSelect,
    state.role ? h('span.role-badge', state.tenant?.deputy_until ? 'Président adjoint' : ROLE_LABELS[state.role]) : null,
    h('span.spacer'),
    state.user ? h('a.bell', { href: '#/notifications', title: 'Alertes', 'aria-label': `Alertes : ${unread} non lue(s)` },
      '🔔', h('span.bell-count', { hidden: unread === 0 }, unread > 9 ? '9+' : String(unread))) : null,
    items.length ? h('a.home-button', { href: '#/', title: 'Accueil', 'aria-label': 'Accueil' }, '🏠') : null,
    nav
      ? h('button.menu-button', {
          'aria-expanded': 'false',
          'aria-label': 'Ouvrir le menu',
          onclick: (e) => {
            const open = bar.classList.toggle('menu-open');
            e.currentTarget.setAttribute('aria-expanded', String(open));
          },
        }, '☰ Menu')
      : logout,
    nav,
  );
  return bar;
}

async function render() {
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* rien */
    }
    cleanup = null;
  }
  app.replaceChildren();
  const hash = location.hash || '#/';
  const route = routes.find((r) => r.re.test(hash)) ?? routes.at(-1);
  const params = hash.match(route.re)?.slice(1) ?? [];

  if (!isSignedIn()) {
    if (route.public) {
      app.append(header());
      const main = safeAppend(h('main.page'));
      app.append(main);
      cleanup = (await route.view(main, ...params)) ?? null;
      return;
    }
    app.append(header());
    const main = h('main.page.narrow', h('h1', 'Connexion'), h('p', 'Un code vous sera envoyé par e-mail : pas de mot de passe à retenir.'));
    app.append(main);
    cleanup = mountSignIn(main);
    return;
  }

  try {
    if (!state.user) await refreshMe();
  } catch (err) {
    // Toujours offrir une sortie : sans cela, une session refusée par l'API
    // bloque l'utilisateur sur cette page (Clerk garde la session ouverte).
    const reason = err?.details?.reason;
    app.append(
      header(),
      h(
        'main.page.narrow',
        h('p.error', errorMessage(err)),
        reason ? h('p.small.muted', `Détail technique : ${reason}`) : null,
        err?.details?.detail ? h('p.small.muted', err.details.detail) : null,
        h(
          'div.buttons',
          h('button', { onclick: () => location.reload() }, 'Réessayer'),
          h('button.primary', {
            onclick: async () => {
              await signOut();
              state.user = null;
              location.hash = '#/';
              location.reload();
            },
          }, 'Se déconnecter'),
        ),
      ),
    );
    return;
  }

  // Invitation ouverte avant connexion : on y revient.
  const pending = sessionStorage.getItem(PENDING_INVITE_KEY);
  if (pending && !route.public) {
    sessionStorage.removeItem(PENDING_INVITE_KEY);
    location.hash = `#/invitation/${pending}`;
    return;
  }

  if (route.tenant && !state.tenant) {
    location.hash = '#/';
    return;
  }
  if (route.roles && !route.roles.includes(state.role)) {
    toast('Votre rôle ne permet pas d’accéder à cette page.', 'error');
    location.hash = '#/';
    return;
  }

  app.append(header());
  const main = safeAppend(h(route.full ? 'main.page.full' : 'main.page'));
  app.append(main);
  try {
    cleanup = (await route.view(main, ...params, { refreshMe, rerender: render })) ?? null;
  } catch (err) {
    main.append(h('p.error', errorMessage(err)));
  }
}

window.addEventListener('hashchange', render);

// Ouverture depuis une notification : « /?tenant=…#/battues/… » sélectionne l'association.
{
  const tenant = new URLSearchParams(location.search).get('tenant');
  if (tenant) {
    state.setTenant(tenant);
    history.replaceState(null, '', `/${location.hash}`);
  }
}
registerServiceWorker();
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'notification') pollUnread();
  if (e.data?.type === 'open') {
    const url = new URL(e.data.url);
    const tenant = url.searchParams.get('tenant');
    if (tenant && tenant !== state.tenantId) state.setTenant(tenant);
    if (location.hash === url.hash) render();
    else location.hash = url.hash;
  }
});

(async () => {
  try {
    await initAuth();
    onAuthChange(() => {
      state.user = null;
      render();
    });
  } catch (err) {
    app.append(h('p.error', `Authentification indisponible : ${errorMessage(err)}`));
    return;
  }
  render();
})();
