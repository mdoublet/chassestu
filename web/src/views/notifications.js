// Alertes reçues (cloche) et activation des notifications sur l'appareil.
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage, fold } from '../ui.js';
import { pushStatus, enablePush, disablePush } from '../push-client.js';

export function pushCard(onChange) {
  const box = h('section.card.push-card');
  async function render() {
    const status = await pushStatus();
    const content = {
      'ios-install': [
        h('h2', '📲 Alertes sur iPhone'),
        h('p.small', 'Installez l’application : Safari → Partager ⬆️ → « Sur l’écran d’accueil ».'),
      ],
      unsupported: [h('p.small.muted', 'Notifications indisponibles sur ce navigateur : voyez la cloche 🔔.')],
      denied: [h('p.small', '🔕 Notifications bloquées : autorisez-les dans les réglages du navigateur (icône à gauche de l’adresse).')],
      disabled: [
        h('div.push-row', h('span', '🔔 Être prévenu sur ce téléphone'),
          h('button.primary', { onclick: () => act(enablePush, 'Notifications activées sur cet appareil.') }, 'Activer')),
      ],
      enabled: [
        h('p', '✅ Notifications activées'),
        h('div.buttons',
          h('button', { onclick: () => act(() => api.post('/push/test', {}, { tenant: false }), 'Notification d’essai envoyée.') }, 'Envoyer un essai'),
          h('button.link.danger', { onclick: () => act(disablePush, 'Notifications désactivées sur cet appareil.') }, 'Désactiver'),
        ),
      ],
    }[status];
    fill(box, content);
    return status;
  }
  async function act(fn, msg) {
    try {
      await fn();
      toast(msg);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    const status = await render();
    onChange?.(status);
  }
  render();
  return box;
}

export async function notificationsView(main, { rerender } = {}) {
  const list = h('section');
  main.append(h('h1', 'Alertes'), list, pushCard());
  try {
    const { notifications } = await api.get('/notifications', { tenant: false });
    const item = (n) => h('li', { class: n.read_at ? '' : 'unread' },
      h('a', {
        href: n.url,
        onclick: (e) => {
          // Alerte d'une autre association : on bascule d'abord dessus.
          if (n.tenant_id && n.tenant_id !== state.tenantId) {
            e.preventDefault();
            state.setTenant(n.tenant_id);
            location.hash = n.url;
            rerender?.();
          }
        },
      },
      h('strong', n.title),
      h('span', n.body),
      h('span.small.muted', `${new Date(n.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}${state.tenants.length > 1 && n.tenant_name ? ` · ${n.tenant_name}` : ''}`)));
    // Groupées par jour : le jour le plus récent ouvert, les autres repliés.
    const days = new Map();
    for (const n of notifications) {
      const d = new Date(n.created_at).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
      days.set(d, [...(days.get(d) ?? []), n]);
    }
    fill(list, notifications.length
      ? [...days].map(([d, ns], i) => fold(d, { open: i === 0, extra: `${ns.length}${ns.some((n) => !n.read_at) ? ' · nouvelles' : ''}` }, h('ul.plain.alerts', ns.map(item))))
      : h('p.muted', 'Aucune alerte pour l’instant.'));
    if (notifications.some((n) => !n.read_at)) {
      await api.post('/notifications/read', {}, { tenant: false });
      window.dispatchEvent(new Event('alerts-changed'));
    }
  } catch (err) {
    fill(list, h('p.error', errorMessage(err)));
  }
}
