// Suppression des comptes de connexion chez Clerk (API d'administration).
// Sans cela, un utilisateur supprimé de l'application pourrait se reconnecter
// et retrouverait un profil vide.

export interface ClerkDeletion {
  deleted: number;
  skipped: number; // comptes de développement (dev_…) ou Clerk non configuré
  failed: string[];
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function deleteClerkUsers(ids: string[], secretKey: string | undefined, fetchImpl: FetchLike = fetch): Promise<ClerkDeletion> {
  const result: ClerkDeletion = { deleted: 0, skipped: 0, failed: [] };
  for (const id of ids) {
    if (!secretKey || !id.startsWith('user_')) {
      result.skipped += 1;
      continue;
    }
    try {
      const res = await fetchImpl(`https://api.clerk.com/v1/users/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      // 404 : déjà supprimé chez Clerk, l'objectif est atteint.
      if (res.ok || res.status === 404) result.deleted += 1;
      else result.failed.push(id);
    } catch {
      result.failed.push(id);
    }
  }
  return result;
}
