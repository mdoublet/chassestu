// Covoiturage du rendez-vous aux parkings (logique pure).
import { describe, expect, it } from 'vitest';
import { planCarpool, type CarpoolPerson } from '../src/carpool';
import { drawAssignments } from '../src/proposal';

const P = (id: string, dest: string, car = false, seats = 0, lon: number | null = null): CarpoolPerson => ({
  id, name: id, hasCar: car, seats, destination: dest, destinationName: dest, lon, lat: lon === null ? null : 45,
});

describe('covoiturage', () => {
  it('passagers avec un conducteur du même parking ; tous les conducteurs prennent leur voiture', () => {
    const plan = planCarpool([
      P('Alain', 'A', true, 4), P('Bruno', 'A'), P('Claude', 'B', true, 3), P('Denis', 'B'), P('Émile', 'A'),
    ], 4);
    expect(plan.cars.map((c) => [c.driver.name, c.passengers.map((p) => p.name)])).toEqual([
      ['Alain', ['Bruno', 'Émile']],
      ['Claude', ['Denis']],
    ]);
    expect(plan.unseated).toEqual([]);
    expect(plan.carsAdvised).toBe(2); // 5 chasseurs ÷ 4 par voiture
  });

  it('le ratio du président plafonne une voiture même si elle a plus de places', () => {
    const plan = planCarpool([P('Alain', 'A', true, 6), P('B1', 'A'), P('B2', 'A'), P('B3', 'A')], 3);
    expect(plan.cars[0].capacity).toBe(2);
    expect(plan.cars[0].passengers.map((p) => p.name)).toEqual(['B1', 'B2']);
    expect(plan.unseated.map((p) => p.name)).toEqual(['B3']);
    expect(plan.carsAdvised).toBe(2);
  });

  it('sans conducteur vers son parking : le parking le plus proche (dépose en chemin)', () => {
    const plan = planCarpool([P('Loin', 'C', true, 3, 5.2), P('Près', 'B', true, 3, 5.01), P('Piéton', 'A', false, 0, 5.0)], 4);
    const car = plan.cars.find((c) => c.passengers.length)!;
    expect(car.driver.name).toBe('Près');
    expect(car.passengers[0]).toMatchObject({ name: 'Piéton', detour: true });
  });
});

describe('tirage au sort et marche', () => {
  it('ne place jamais un chasseur sur un poste trop difficile ; non placé plutôt que mal placé', () => {
    const mobility = {
      difficulty: new Map<string, number | null>([['p1', 5], ['p2', 4]]),
      ability: new Map<string, number | null>([['lent', 2], ['rapide', 5]]),
    };
    for (let run = 0; run < 20; run++) {
      const { assignments, unplaced } = drawAssignments(['p1', 'p2'], ['lent', 'rapide'], [], true, undefined, mobility);
      expect(assignments.find((a) => a.participant_id === 'lent')).toBeUndefined();
      expect(unplaced).toEqual(['lent']);
    }
  });

  it('les postes de difficulté inconnue restent accessibles à tous', () => {
    const mobility = { difficulty: new Map<string, number | null>([['p1', null]]), ability: new Map<string, number | null>([['lent', 1]]) };
    expect(drawAssignments(['p1'], ['lent'], [], false, undefined, mobility).assignments).toEqual([{ post_id: 'p1', participant_id: 'lent' }]);
  });
});
