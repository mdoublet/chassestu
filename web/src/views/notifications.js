// Alertes reçues (cloche) et activation des notifications sur l'appareil.
import { api } from '../api.js';
import { state } from '../state.js';
import { h, fill, toast, errorMessage } from '../ui.js';
import { pushStatus, enablePush, disablePush } from '../push-client.js';

export function pushCard(onChange) {
  const box = h('section.card.push-card');
  async function render() {
    const status = await pushStatus();
    const content = {
      'ios-install': [
        h('h2', '📲 Recevoir les alertes sur cet iPhone'),
        h('p', 'Sur iPhone, les notifications ne fonctionnent que si l’application est installée : dans Safari, touchez Partager ⬆️ puis « Sur l’écran d’accueil », et ouvrez Chasses-tu ? depuis son icône.'),
        h('p.small.muted', 'En attendant, vos alertes apparaissent dans la cloche 🔔.'),
      ],
      unsupported: [h('h2', 'Notifications'), h('p.small.muted', 'Ce navigateur ne permet pas les notifications : vos alertes apparaissent dans la cloche 🔔.')],
      denied: [h('h2', '🔕 Notifications bloquées'), h('p', 'Vous avez refusé les notifications pour ce site. Pour les réactiver, autorisez-les dans les réglages du navigateur (icône à gauche de l’adresse), puis rechargez la page.')],
      disabled: [
        h('h2', '🔔 Être prévenu sur cet appareil'),
        h('p', 'Convocations, attribution de votre poste, début et fin de battue : recevez-les comme un SMS, même application fermée.'),
        h('button.primary', { onclick: () => act(enablePush, 'Notifications activées sur cet appareil.') }, 'Activer les notifications'),
      ],
      enabled: [
        h('h2', '✅ Notifications activées sur cet appareil'),
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
  main.append(h('h1', 'Alertes'), pushCard(), list);
  try {
    const { notifications } = await api.get('/notifications', { tenant: false });
    fill(
      list,
      notifications.length
        ? h('ul.plain.alerts', notifications.map((n) =>
            h('li', { class: n.read_at ? '' : 'unread' },
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
              h('span.small.muted', `${new Date(n.created_at).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${state.tenants.length > 1 && n.tenant_name ? ` · ${n.tenant_name}` : ''}`)),
            )))
        : h('p.muted', 'Aucune alerte pour l’instant.'),
    );
    if (notifications.some((n) => !n.read_at)) {
      await api.post('/notifications/read', {}, { tenant: false });
      window.dispatchEvent(new Event('alerts-changed'));
    }
  } catch (err) {
    fill(list, h('p.error', errorMessage(err)));
  }
}
