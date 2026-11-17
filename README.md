# Battues — gestion des postes de chasse

Web app mobile-first (PWA) multi-tenant : le président d'une association de
chasse cartographie ses territoires (territoires, réserves, postes, parkings,
chemins d'accès) sur fond IGN ; les battues, l'attribution des postes et le
guidage GPS des chasseurs viendront dans les lots suivants.

Cette version livre les **lots 0 (socle multi-tenant) et 1 (éditeur
cartographique)** de la spécification.

## Architecture

| Couche | Choix |
| --- | --- |
| Front | Vite, JavaScript sans framework, Leaflet + Leaflet-Geoman (libre), Turf.js — `web/` |
| API | Cloudflare Workers, Hono, TypeScript — `api/` |
| Base | Neon PostgreSQL + PostGIS, Row Level Security — `db/migrations/` |
| Auth | Clerk (connexion par code e-mail, sans mot de passe) |
| Cartes | Géoplateforme IGN (WMTS : Plan IGN, photos aériennes, cadastre) |

### Isolation des tenants (à lire avant de toucher à l'API)

Sur Neon, le rôle propriétaire `neondb_owner` a l'attribut `BYPASSRLS` : avec
lui, **les politiques RLS sont ignorées**, même si l'API pose bien
`app.tenant_id`. L'API exécute donc chaque transaction ainsi :

```sql
BEGIN;
SET LOCAL ROLE app_rls;                          -- rôle sans BYPASSRLS, non propriétaire
SELECT set_config('app.user_id', $1, true),
       set_config('app.tenant_id', $2, true);
-- … requêtes de l'action …
COMMIT;
```

`app.current_tenant_id()` ne renvoie le tenant demandé **que si l'utilisateur
en est membre** : un en-tête `X-Tenant-Id` forgé ne donne accès à rien. Les
tests le vérifient sur chaque table portant `tenant_id` (liste lue dans le
catalogue, donc les tables futures sont couvertes automatiquement).

### Écarts assumés par rapport à la spécification

- **Clerk sert à l'identité uniquement, pas Clerk Organizations.** Tenants,
  rôles et invitations sont dans notre base : c'est ce que lit la RLS, cela
  permet le lien d'invitation copiable (WhatsApp/SMS) avec nos rôles, et évite
  de synchroniser deux sources de vérité. Ce choix supprime aussi la
  dépendance au forfait « Organizations » de Clerk (question ouverte sur le
  modèle économique).
- **Une réserve qui engloberait un poste existant est refusée** (de même
  qu'un contour de territoire qui exclurait un poste). Le statut « poste
  invalide » arrivera au lot 2 avec les zones d'exclusion.
- **WFS BD TOPO (lot 2)** : le GetCapabilities de `data.geopf.fr/wfs`
  (novembre 2026) expose `BDTOPO_V3:batiment`, pas la forme `bd_topo:batiment`
  citée dans la spécification. Le lot 2 devra lire le GetCapabilities, comme
  prévu.
- **Fonds IGN** : la matrice de tuiles annoncée est `PM_0_19` (vérifiée).

## Démarrage

Prérequis : Node 20+, un projet Neon (avec PostGIS), un compte Clerk et un
compte Cloudflare.

```bash
npm install
```

### 1. Base de données Neon

```bash
cp .env.example .env      # puis renseigner DATABASE_URL (rôle neondb_owner)
```

```bash
npm run db:migrate
```

Les migrations sont des fichiers SQL versionnés (`db/migrations/`), appliqués
une seule fois chacun et vérifiés par somme de contrôle. Ne modifiez jamais une
migration déjà appliquée : ajoutez-en une nouvelle.

Premier super-administrateur : connectez-vous une fois dans l'application,
puis dans la console SQL Neon :

```sql
UPDATE users SET is_super_admin = true WHERE id = '<identifiant Clerk user_…>';
```

Il crée ensuite les associations depuis la page « Administration » et transmet
au président le lien d'invitation (usage unique, 14 jours).

### 2. Clerk

Dans le tableau de bord Clerk : activer la connexion par **code e-mail**,
désactiver le mot de passe. Optionnel : ajouter `name` et `email` au modèle de
jeton de session pour pré-remplir le profil.

### 3. API (Cloudflare Workers, construite depuis GitHub)

Tableau de bord Cloudflare → Workers & Pages → Create → Import a repository :

- dépôt `mdoublet/chassestu`, répertoire racine `/` ;
- commande de build : vide ; commande de déploiement :
  `npx wrangler deploy --config api/wrangler.toml` ;
- Settings → Variables and Secrets :
  - secrets `DATABASE_URL`, `CLERK_SECRET_KEY` ;
  - variables `APP_ORIGIN` et `CLERK_AUTHORIZED_PARTIES` = adresse du site
    (ex. `https://chassestu.pages.dev`).

`keep_vars = true` (dans `api/wrangler.toml`) conserve ces variables à chaque
déploiement. En ligne de commande : `npx wrangler deploy --config api/wrangler.toml`.

### 4. Front (Cloudflare Pages, construit depuis GitHub)

Workers & Pages → Create → Pages → Connect to Git : répertoire racine `/`,
commande `npm run build -w web`, dossier de sortie `web/dist`. Variables :
`VITE_CLERK_PUBLISHABLE_KEY`, `VITE_API_URL` (adresse du Worker).

### Base sans outil local

Si `npm run db:migrate` n'est pas utilisable, `db/neon-console.sql` contient
toutes les migrations en une transaction : à coller une fois dans l'éditeur
SQL de Neon, sur une base vide. Le régénérer avec `npm run db:bundle` après
chaque nouvelle migration (`db:migrate` reconnaît ensuite ce qui est appliqué).

## Développement local

Sans Clerk ni Neon, avec un PostgreSQL local contenant PostGIS :

```bash
DATABASE_URL=postgresql://… npm run db:migrate
```

```bash
npm run dev:api:node        # lit DATABASE_URL dans .env
```

```bash
npm run dev:web
```

Sans `VITE_CLERK_PUBLISHABLE_KEY`, le front propose une connexion simulée
(identifiant libre) ; l'API l'accepte uniquement avec `AUTH_MODE=dev`, et la
refuse si `ENVIRONMENT=production`.

`npm run dev:api` lance `wrangler dev` (pilote Neon) avec `api/.dev.vars`
(voir `api/.dev.vars.example`).

## Tests

```bash
npm test
```

- `api/test` : tests d'intégration sur un vrai PostgreSQL + PostGIS. La base de
  test est recréée à chaque lancement depuis un modèle contenant PostGIS
  (`TEST_TEMPLATE_DB`, défaut `postgis_template`) ; `TEST_DATABASE_URL` doit
  désigner une base **locale** dont le nom contient « test » (garde-fou).
- `web/test` : simplification Douglas-Peucker en mètres, import GPX/KML/GeoJSON,
  contrôles des postes, historique d'annulation.

Préparer le modèle une fois (superutilisateur local) :

```sql
CREATE DATABASE postgis_template;
\c postgis_template
CREATE EXTENSION postgis;
ALTER DATABASE postgis_template IS_TEMPLATE true;
```

## Avancement

**Lot 0 — Socle multi-tenant**

- [x] Un utilisateur du tenant A ne lit ni n'écrit aucune ligne du tenant B, sur chaque table (test automatisé).
- [x] Un président génère un lien d'invitation ; un nouvel utilisateur qui l'ouvre devient Chasseur du tenant.
- [x] Un utilisateur membre de deux tenants bascule de l'un à l'autre.

**Lot 1 — Éditeur cartographique**

- [x] Le président dessine, modifie et supprime territoire, réserve, parking, poste et chemin sur fond IGN.
- [x] Un polygone auto-intersectant est refusé par l'API.
- [x] Import d'un fichier GPX, KML ou GeoJSON et export GeoJSON du territoire.
- [x] Un chemin enregistré en marchant est simplifié puis éditable (simplification testée ; GPS réel non testé sur téléphone).

Également : annulation Ctrl+Z (50 pas), accrochage aux sommets, contrôle du
poste pendant le glisser-déposer (client) et à l'enregistrement (PostGIS),
journal d'audit de la cartographie et des appartenances.

**Pas encore fait** (prévu dans la spécification, hors lots 0-1 ou reporté) :
limitation de débit de l'API, consultation des journaux par le super-admin,
avertissement de renumérotation lié aux plans de couverture (lot 3), service
worker et mode hors-ligne (lot 6), export PDF et pages légales (lot 7).
