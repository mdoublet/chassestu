// Journée montrée dans « Ma chasse » (sans DOM, testé).

/**
 * Journée à montrer : celle en cours, sinon la prochaine convocation.
 * Chasseur : seulement celles où il est convoqué. Gestion (`manager`) :
 * toutes, et à défaut le prochain brouillon.
 */
export function pickDay(days, today, { manager = false } = {}) {
  const mine = manager ? days : days.filter((d) => d.convoked_me !== false);
  const next = (status) => mine.filter((d) => d.status === status && d.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  return mine.find((d) => d.status === 'en_cours') ?? next('convoquee') ?? (manager ? next('brouillon') : null) ?? null;
}
