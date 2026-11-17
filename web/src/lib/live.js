/** Rythme rapide pendant la battue et le jour même (rond du matin imminent). */
export function isLive(status, date, today = localToday()) {
  return status === 'en_cours' || (status === 'publiee' && !!date && date <= today);
}
export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Mises à jour automatiques : surveille un numéro de version et recharge
// l'écran quand il change. Fréquence rapide pendant une battue en cours.
export function watchRevision(fetchRevision, onChange, { fastMs = 10_000, slowMs = 60_000 } = {}) {
  let last = null;
  let fast = false;
  let timer = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    if (document.visibilityState === 'visible') {
      try {
        const { revision, status, date } = await fetchRevision();
        fast = isLive(status, date);
        // onChange renvoie false s'il n'a pas pu appliquer (saisie en cours) : on réessaiera.
        if (last === null || revision === last || (await onChange()) !== false) last = revision;
      } catch {
        /* réseau absent : on réessaiera */
      }
    }
    if (!stopped) timer = setTimeout(tick, fast ? fastMs : slowMs);
  }
  const now = () => {
    clearTimeout(timer);
    tick();
  };
  const onVisible = () => document.visibilityState === 'visible' && now();
  const onMessage = (e) => e.data?.type === 'notification' && now();
  document.addEventListener('visibilitychange', onVisible);
  navigator.serviceWorker?.addEventListener('message', onMessage);
  tick();
  return {
    /** À appeler après une modification faite sur cet écran (évite un rechargement inutile). */
    async sync() {
      try {
        last = (await fetchRevision()).revision;
      } catch {
        /* rien */
      }
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      navigator.serviceWorker?.removeEventListener('message', onMessage);
    },
  };
}

/** Rafraîchissement périodique simple (listes) tant que la page est visible. */
export function every(ms, fn) {
  const id = setInterval(() => document.visibilityState === 'visible' && fn(), ms);
  return () => clearInterval(id);
}
