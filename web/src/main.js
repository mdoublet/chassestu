import './style.css';
import { initAuth, isSignedIn, mountSignIn, signOut, onAuthChange } from './auth.js';
import { api } from './api.js';
import { state } from './state.js';
import { h, errorMessage, toast, ROLE_LABELS } from './ui.js';
import { homeView } from './views/home.js';
import { membersView } from './views/members.js';
import { settingsView } from './views/settings.js';
import { adminView } from './views/admin.js';
import { invitationView, PENDING_INVITE_KEY } from './views/invitation.js';

const app = document.getElementById('app');
let cleanup = null;

// Routes (hachage) : #/, #/carte, #/membres, #/parametres, #/admin, #/invitation/<jeton>
const routes = [
  { re: /^#\/invitation\/([A-Za-z0-9_-]+)$/, view: invitationView, public: true },
  { re: /^#\/carte$/, view: (el) => import('./views/editor.js').then((m) => m.editorView(el)), tenant: true, full: true },
  { re: /^#\/membres$/, view: membersView, tenant: true, roles: ['president', 'responsable'] },
  { re: /^#\/parametres$/, view: settingsView, tenant: true, roles: ['president'] },
  { re: /^#\/admin$/, view: adminView },
  { re: /^#?\/?$/, view: homeView },
];

export async function refreshMe() {
  state.setMe(await api.get('/me', { tenant: false }));
}

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

  return h(
    'header.topbar',
    h('a.brand', { href: '#/' }, 'Battues'),
    tenantSelect,
    state.role ? h('span.role-badge', ROLE_LABELS[state.role]) : null,
    h('span.spacer'),
    state.user
      ? h('button.link', {
          onclick: async () => {
            await signOut();
            location.hash = '#/';
            location.reload();
          },
        }, 'Déconnexion')
      : null,
  );
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
      const main = h('main.page');
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
    app.append(header(), h('main.page', h('p.error', errorMessage(err))));
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
  const main = h(route.full ? 'main.page.full' : 'main.page');
  app.append(main);
  try {
    cleanup = (await route.view(main, ...params, { refreshMe, rerender: render })) ?? null;
  } catch (err) {
    main.append(h('p.error', errorMessage(err)));
  }
}

window.addEventListener('hashchange', render);

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
