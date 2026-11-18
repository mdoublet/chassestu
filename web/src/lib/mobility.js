// Marche des chasseurs et difficulté d'accès des postes (même règle que l'API).

/** Le chasseur peut-il tenir ce poste ? (inconnu d'un côté ou de l'autre : oui) */
export function canReach(difficulty, ability) {
  return difficulty == null || ability == null || difficulty <= ability;
}
