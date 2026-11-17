# Chasses-tu ? — gestion des battues et des postes de chasse

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
SQL de Neon, sur une base vide. Pour une base existante, coller seulement le
fichier de la nouvelle migration dans `db/neon-updates/` (il refuse de
s'appliquer deux fois ou dans le désordre). Les régénérer avec
`npm run db:bundle` après chaque nouvelle migration ; `db:migrate` reconnaît
ensuite ce qui est appliqué. **Appliquer la migration avant de déployer le
code qui en dépend.**

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

**Lot 2 — Règle des 150 m**

- [x] Les bâtiments BD TOPO de l'emprise élargie sont importés, y compris ceux situés hors du territoire (import automatique à la création du territoire, bouton « Actualiser les bâtiments »).
- [x] La zone d'exclusion s'affiche avec sa surface en hectares (et le % du territoire).
- [x] Un poste placé à 140 m d'une habitation est refusé côté client et côté serveur ; à 170 m il est accepté avec avertissement.
- [x] Ignorer un bâtiment exige une raison et apparaît dans le journal d'audit.
- [x] Passer buffer_distance_m de 150 à 200 recalcule les zones et invalide les postes concernés.

Choix du lot 2 :
- `exclusion_zones` est une **table** recalculée par déclencheur, pas une vue
  matérialisée : une vue matérialisée ne supporte pas la RLS.
- Bande d'avertissement = distance minimale + 50 m (150 → 200 m par défaut ;
  200 → 250 m si la distance passe à 200 m).
- Un poste rendu illégal (nouvelle habitation, distance augmentée) est marqué
  invalide, pas supprimé ; il reste modifiable et redevient valide une fois déplacé.
- Un bâtiment disparu de la BD TOPO reste compté (prudence) et est signalé
  « à vérifier » ; seul le président peut l'ignorer.
- Bâtiments importés dans un rayon de 300 m autour du territoire (au moins
  distance + 50 m), pour ne pas réimporter si la distance passe à 200 m.
- Service WFS de l'IGN parfois surchargé : nouvelles tentatives, et le
  territoire est créé même si l'import échoue (bouton « Actualiser » ensuite).
- Test d'intégration avec le vrai service IGN : `IGN=1 npm test -w api`.

**Postes hors du territoire** : autorisés jusqu'à `post_max_outside_m`
(200 m par défaut, réglable, 0 = interdit), toujours à la bonne distance des
habitations ; refusés si les bâtiments n'ont pas été importés à cet endroit ;
aucune réserve de l'association ne peut contenir un poste.

**Lot 3 — Plans de couverture**

- [x] Les plans de l'exemple (5 et 6 chasseurs) se saisissent dans la grille et s'affichent sur la carte.
- [x] Une ligne dont le nombre de postes cochés diffère de l'effectif ne peut pas être enregistrée (client et base).
- [x] Un poste invalidé signale en rouge les plans qui l'utilisent (aussi : poste désactivé ou supprimé).

Choix du lot 3 : un poste invalide ou désactivé ne peut pas être coché ; la
validité d'un plan est calculée à la lecture (jamais de modification
silencieuse) ; renuméroter, désactiver ou supprimer un poste utilisé dans des
plans demande confirmation. La proposition des postes selon l'effectif du jour
relève du lot 4.

**Lot 4 — Battue et attribution**

- [x] Avec 6 postés présents, les postes 1, 3, 5, 8, 10 et 13 sont proposés.
- [x] Avec 7 postés et aucun plan pour 7, le plan à 6 est proposé et le responsable ajoute un poste.
- [x] Le tirage au sort respecte les postes verrouillés.
- [x] Un invité sans compte accède à son poste par lien, et ce lien expire à la clôture (ou s'il est régénéré / révoqué).

Choix du lot 4 : attribution par liste déroulante par poste (plus fiable au
téléphone que le glisser-déposer) avec cadenas de verrouillage ; « doublon de
poste » = deux chasseurs au plus par poste, sur choix explicite ;
notifications = messages prêts à copier pour WhatsApp à chaque étape ; voisins
= postes précédent et suivant dans la ligne du jour (tous si l'association le
permet).

**Alertes et notifications** : à chaque étape d'une battue (convocation,
annulation, attribution du poste, début, fin), chaque participant concerné
reçoit une alerte dans l'application (cloche 🔔) et, s'il les a activées, une
notification push (Web Push chiffré, RFC 8291/8292, clés VAPID générées par
l'API au premier usage). Sur iPhone, le push exige l'application installée
sur l'écran d'accueil (iOS 16.4+). Les invités sans compte reçoivent toujours
leur lien à la main.

**Vue chasseur et mises à jour automatiques** : président et responsables
ont deux onglets sur une battue, « 👁 Vue chasseur » (ce que voit un chasseur)
et « ⚙ Gestion ». La vue chasseur affiche un bandeau « quoi faire
maintenant » (répondre, rejoindre le rendez-vous, rejoindre le poste n° X,
battue en cours, terminée, annulée), l'itinéraire voiture (Google Maps, Waze,
Plans) vers le rendez-vous et le parking, les consignes, les espèces chassées
avec leur quota et les prélèvements déclarés. Chaque modification d'une battue
incrémente `hunts.revision` (déclencheurs) ; les écrans interrogent
`GET /hunts/:id/revision` toutes les 10 s le jour de la battue (60 s sinon) et
ne rechargent que si elle a changé ; une notification reçue ou le retour sur
l'onglet déclenchent une vérification immédiate. Une saisie en cours n'est
jamais écrasée. Les prélèvements sont un **décompte par battue** (le chasseur
déclare les siens pendant la battue, le responsable corrige pendant et après) :
ce n'est pas le carnet de prélèvements individuel, hors du périmètre V1.

**Migrations** : l'API applique elle-même les migrations en attente à la
première requête après un déploiement (`api/src/migrate.ts`, migrations
embarquées générées par `npm run db:bundle`).

**Pas encore fait** (prévu dans la spécification, hors lots 0-1 ou reporté) :
limitation de débit de l'API, consultation des journaux par le super-admin,
service
worker et mode hors-ligne (lot 6), export PDF et pages légales (lot 7).
