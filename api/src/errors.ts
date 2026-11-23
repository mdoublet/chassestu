import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class AppError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const SPATIAL_MESSAGES: Record<string, string> = {
  POST_OUTSIDE_TERRITORY: 'Le poste doit être placé à l’intérieur du territoire.',
  POST_OUTSIDE_BUILDINGS: 'Les bâtiments n’ont pas été importés à cet endroit : cliquez sur « Actualiser les bâtiments » avant de poster hors du territoire.',
  POST_IN_RESERVE: 'Le poste ne peut pas être placé dans une zone de réserve.',
  PARKING_NOT_A_PARKING: 'Le parking choisi doit être un lieu public de type « Parking ».',
  RESERVE_OUTSIDE_TERRITORY: 'La zone de réserve doit recouper le territoire.',
};

/** Traduit les erreurs PostgreSQL en erreurs HTTP lisibles. */
export function fromPgError(err: any): AppError | null {
  if (!err || typeof err.code !== 'string') return null;
  const msg: string = err.message ?? '';
  switch (err.code) {
    case '23514': {
      const m = /^([A-Z_]+): (.*)$/.exec(msg);
      if (m) return new AppError(422, m[1], SPATIAL_MESSAGES[m[1]] ?? capitalize(m[2]));
      return new AppError(422, 'CONSTRAINT', 'Donnée refusée par une règle de validation.', err.constraint);
    }
    case '23505':
      if (err.constraint === 'posts_territory_id_number_key') {
        return new AppError(409, 'POST_NUMBER_TAKEN', 'Ce numéro de poste est déjà utilisé sur ce territoire.');
      }
      return new AppError(409, 'DUPLICATE', 'Cet élément existe déjà.');
    case '23503':
      return new AppError(422, 'REFERENCE', 'Élément lié introuvable.');
    case '42501': {
      // Refus levé par nos fonctions (« CODE: message ») ; les refus natifs restent génériques.
      const m = /^([A-Z_]+): (.*)$/.exec(msg);
      if (m) return new AppError(403, m[1], capitalize(m[2]));
      return new AppError(403, 'FORBIDDEN', 'Action non autorisée.');
    }
    case 'P0002':
      return new AppError(404, msg.split(':')[0] || 'NOT_FOUND', 'Introuvable.');
    case 'P0001':
      if (msg.startsWith('INVITATION_INVALID')) {
        return new AppError(410, 'INVITATION_INVALID', 'Ce lien d’invitation a expiré ou a été révoqué.');
      }
      return new AppError(400, 'INVALID', msg);
    case 'XX000':
    case '22023':
      // ST_GeomFromGeoJSON sur une entrée mal formée
      if (/geojson|geometry/i.test(msg)) return new AppError(400, 'GEOMETRY_PARSE', 'Géométrie illisible.');
      return null;
    default:
      return null;
  }
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
