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
  const [{ Clerk }, { frFR }] = await Promise.all([import('@clerk/clerk-js'), import('@clerk/localizations')]);
  clerk = new Clerk(CLERK_KEY);
  await clerk.load({ localization: frFR });
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

export function mountSignIn(container) {
  if (clerk) {
    const el = h('div');
    container.append(el);
    clerk.mountSignIn(el, { forceRedirectUrl: location.href, signUpForceRedirectUrl: location.href });
    return () => clerk.unmountSignIn(el);
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
