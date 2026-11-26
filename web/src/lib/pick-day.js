// Journée montrée dans « Ma chasse » (sans DOM, testé).

/** Journée à montrer : celle en cours (où je suis convoqué), sinon la prochaine convocation. */
export function pickDay(days, today) {
  const mine = days.filter((d) => d.convoked_me !== false);
  return mine.find((d) => d.status === 'en_cours')
    ?? mine.filter((d) => d.status === 'convoquee' && d.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0]
    ?? null;
}
