// État global minimal de l'application.
const TENANT_KEY = 'chassestu.tenantId';

function stored() {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
}

export const state = {
  /** { id, display_name, email, phone, is_super_admin } */
  user: null,
  /** [{ id, name, kind, role }] */
  tenants: [],
  tenantId: stored(),

  get tenant() {
    return this.tenants.find((t) => t.id === this.tenantId) ?? null;
  },
  get role() {
    return this.tenant?.role ?? null;
  },

  setMe({ user, tenants }) {
    this.user = user;
    this.tenants = tenants;
    if (!this.tenant) this.setTenant(tenants[0]?.id ?? null);
  },

  setTenant(id) {
    this.tenantId = id;
    try {
      if (id) localStorage.setItem(TENANT_KEY, id);
      else localStorage.removeItem(TENANT_KEY);
    } catch {
      /* stockage indisponible (navigation privée) : sans conséquence */
    }
  },
};
