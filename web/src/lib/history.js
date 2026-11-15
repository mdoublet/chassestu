// Historique d'annulation de l'éditeur.
// Chaque modification est déjà enregistrée côté serveur ; annuler revient à
// appliquer l'opération inverse. Un objet supprimé puis recréé change
// d'identifiant : la table `aliases` redirige les anciennes références.

export class History {
  constructor(limit = 50) {
    this.limit = limit;
    this.stack = [];
    this.aliases = new Map();
    this.busy = false;
    this.listeners = new Set();
  }

  /** Identifiant courant d'un objet (après recréations éventuelles). */
  resolve(id) {
    let cur = id;
    for (let i = 0; i < 100 && this.aliases.has(cur); i++) cur = this.aliases.get(cur);
    return cur;
  }

  alias(oldId, newId) {
    if (oldId && newId && oldId !== newId) this.aliases.set(oldId, newId);
  }

  /**
   * @param {{ label: string, undo: (h: History) => Promise<void> }} entry
   */
  push(entry) {
    this.stack.push(entry);
    if (this.stack.length > this.limit) this.stack.shift();
    this.emit();
  }

  get size() {
    return this.stack.length;
  }

  peekLabel() {
    return this.stack.at(-1)?.label ?? null;
  }

  async undo() {
    if (this.busy || this.stack.length === 0) return null;
    const entry = this.stack.pop();
    this.busy = true;
    try {
      await entry.undo(this);
      return entry.label;
    } finally {
      // En cas d'échec (ex. conflit), l'entrée n'est pas remise en pile.
      this.busy = false;
      this.emit();
    }
  }

  clear() {
    this.stack = [];
    this.aliases.clear();
    this.emit();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }
}
