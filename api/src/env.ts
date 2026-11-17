import type { DbPool } from './db';
import type { Bbox } from './bdtopo';
import type { PushTarget } from './push';

export interface Env {
  /** Chaîne de connexion Neon (secret). */
  DATABASE_URL: string;
  /** "production" | "development". Le mode d'auth "dev" est refusé en production. */
  ENVIRONMENT?: string;
  /** "clerk" (défaut) ou "dev" (jetons `dev:<id>:<nom>`, développement local uniquement). */
  AUTH_MODE?: string;
  CLERK_SECRET_KEY?: string;
  /** Clé publique PEM de Clerk : vérification sans appel réseau (recommandé). */
  CLERK_JWT_KEY?: string;
  /** Origines autorisées (claim azp), séparées par des virgules. */
  CLERK_AUTHORIZED_PARTIES?: string;
  /** Origine du front, pour CORS et les liens d'invitation. */
  APP_ORIGIN: string;
}

export interface AuthUser {
  id: string;
  name?: string;
  email?: string;
}

export type AppVariables = {
  user: AuthUser;
  pool: DbPool;
  /** Récupère les pages GeoJSON des bâtiments BD TOPO (remplaçable dans les tests). */
  fetchBuildingPages: (bbox: Bbox) => Promise<string[]>;
  /** Notifications push à envoyer après validation de la transaction. */
  pushQueue: PushTarget[];
  /** fetch utilisé pour les envois push (remplaçable dans les tests). */
  pushFetch: (input: string, init?: RequestInit) => Promise<Response>;
};

export type AppEnv = { Bindings: Env; Variables: AppVariables };
