// Authentification : Clerk (connexion par code e-mail, sans mot de passe)
// si VITE_CLERK_PUBLISHABLE_KEY est défini, sinon mode développement local
// (identifiant libre, accepté uniquement par une API en AUTH_MODE=dev).
import { h } from './ui.js';

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const DEV_KEY = 'chassestu.devUser';
let clerk = null;

export const authMode = CLERK_KEY ? 'clerk' : 'dev';

export async function initAuth() {
  if (!CLERK_KEY) return;
  // Depuis clerk-js 6, les écrans (formulaire de connexion…) sont dans @clerk/ui.
  const [{ Clerk }, { ui }, { frFR }] = await Promise.all([
    import('@clerk/clerk-js'),
    import('@clerk/ui'),
    import('@clerk/localizations'),
  ]);
  clerk = new Clerk(CLERK_KEY);
  // Navigation de Clerk : étapes internes (#/factor-one…) dans la page ; une
  // fois la session ouverte, rechargement complet de la page demandée (l'état
  // de Clerk n'est pas toujours à jour sans cela : écran vide après le code).
  const navigate = (to, replace) => {
    const u = new URL(to, location.href);
    const samePage = u.origin === location.origin && u.pathname === location.pathname && u.search === location.search;
    if (sessionReady()) return reloadInto(u.href);
    if (!samePage) return location[replace ? 'replace' : 'assign'](u.href);
    if (replace) history.replaceState(history.state, '', u.hash || '#/');
    else location.hash = u.hash || '#/';
    return undefined;
  };
  await clerk.load({
    ui: { ClerkUI: ui.ClerkUI },
    localization: frFR,
    routerPush: (to) => navigate(to, false),
    routerReplace: (to) => navigate(to, true),
  });
}

/** Session ouverte (même si clerk.user n'est pas encore rempli). */
function sessionReady() {
  return Boolean(clerk && (clerk.user || clerk.session));
}

/** Recharge la page voulue ; au plus une fois toutes les 20 secondes (pas de boucle). */
const RELOAD_KEY = 'chassestu.authReload';
function reloadInto(url) {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 20_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch { /* rien */ }
  location.replace(url);
  setTimeout(() => location.reload(), 50);
  return true;
}

function devUser() {
  try {
    return JSON.parse(localStorage.getItem(DEV_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export function isSignedIn() {
  return clerk ? Boolean(clerk.user) : Boolean(devUser());
}

export async function getToken() {
  if (clerk) return (await clerk.session?.getToken()) ?? null;
  const u = devUser();
  return u ? `dev:${u.id}:${encodeURIComponent(u.name)}` : null;
}

/** Nom proposé par le fournisseur d'identité (pour pré-remplir le profil). */
export function providerName() {
  if (clerk?.user) return clerk.user.fullName || clerk.user.firstName || '';
  return devUser()?.name ?? '';
}

/** Appelle `fn` uniquement quand l'état connecté/déconnecté change. */
export function onAuthChange(fn) {
  if (!clerk) return;
  let signedIn = Boolean(clerk.user);
  clerk.addListener(({ user }) => {
    if (Boolean(user) !== signedIn) {
      signedIn = Boolean(user);
      fn(signedIn);
    }
  });
}

export async function signOut() {
  if (clerk) await clerk.signOut();
  else localStorage.removeItem(DEV_KEY);
}

/**
 * Formulaire de connexion. `returnHash` : page de l'application à afficher
 * ensuite (jamais une étape interne de Clerk comme « #/factor-one »).
 * `onSignedIn` est appelé dès que la session existe : l'application
 * s'affiche sans rafraîchir, même si Clerk ne redirige pas.
 */
export function mountSignIn(container, { returnHash = '#/', onSignedIn = null } = {}) {
  if (clerk) {
    const el = h('div');
    container.append(el);
    const url = `${location.origin}${location.pathname}${location.search}${returnHash}`;
    clerk.mountSignIn(el, { forceRedirectUrl: url, signUpForceRedirectUrl: url });
    // Filet de sécurité : session ouverte mais pas de navigation de Clerk.
    const timer = setInterval(() => {
      if (clerk.user && onSignedIn) {
        clearInterval(timer);
        onSignedIn();
      } else if (sessionReady()) {
        clearInterval(timer);
        reloadInto(url);
      }
    }, 500);
    return () => {
      clearInterval(timer);
      clerk.unmountSignIn(el);
    };
  }
  const id = h('input', { name: 'id', required: true, pattern: '[A-Za-z0-9_\\-]{1,64}', placeholder: 'ex. marc' });
  const name = h('input', { name: 'name', required: true, maxlength: 120, placeholder: 'ex. Marc Dupont' });
  const form = h(
    'form.card',
    {
      onsubmit: (e) => {
        e.preventDefault();
        localStorage.setItem(DEV_KEY, JSON.stringify({ id: id.value, name: name.value }));
        location.reload();
      },
    },
    h('p.notice', 'Mode développement : Clerk n’est pas configuré. Choisissez un identifiant de test.'),
    h('label', 'Identifiant', id),
    h('label', 'Nom affiché', name),
    h('button.primary', { type: 'submit' }, 'Se connecter'),
  );
  container.append(form);
  return () => {};
}
