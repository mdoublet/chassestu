// Covoiturage d'une battue : du point de rendez-vous aux parkings des postes.
//
// Principe (choisi avec l'association) :
// * chaque chasseur qui a une voiture la prend : on ne cherche pas à réduire
//   le nombre de voitures, elles serviront aux battues suivantes ;
// * une voiture transporte au plus `maxPerCar` chasseurs, conducteur compris
//   (réglage du président), et pas plus que ses places libres ;
// * un passager monte de préférence avec un conducteur qui va au même
//   parking, sinon avec celui dont le parking est le plus proche du sien
//   (dépose en chemin) ;
// * on signale les passagers sans place et le nombre de voitures conseillé
//   (effectif ÷ maxPerCar, arrondi au-dessus).

export interface CarpoolPerson {
  id: string;
  name: string;
  hasCar: boolean;
  seats: number;            // places libres (hors conducteur)
  destination: string;      // identifiant du parking, ou 'traque'
  destinationName: string;
  lon: number | null;
  lat: number | null;
}

export interface CarpoolCar {
  driver: { id: string; name: string };
  destination: string;
  destinationName: string;
  capacity: number;
  passengers: { id: string; name: string; destinationName: string; detour: boolean }[];
}

export interface CarpoolPlan {
  cars: CarpoolCar[];
  unseated: { id: string; name: string; destinationName: string }[];
  carsAdvised: number;
  maxPerCar: number;
}

type Where = { lon: number | null; lat: number | null };
function distance(a: Where, b: Where) {
  if (a.lon === null || a.lat === null || b.lon === null || b.lat === null) return Infinity;
  const k = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot((a.lon - b.lon) * k, a.lat - b.lat) * 111_195;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'fr');

export function planCarpool(people: CarpoolPerson[], maxPerCar: number): CarpoolPlan {
  const drivers = people.filter((p) => p.hasCar).sort(byName);
  const passengers = people.filter((p) => !p.hasCar).sort(byName);
  const cars = drivers.map((d) => ({
    car: {
      driver: { id: d.id, name: d.name },
      destination: d.destination,
      destinationName: d.destinationName,
      capacity: Math.max(0, Math.min(d.seats, maxPerCar - 1)),
      passengers: [] as CarpoolCar['passengers'],
    },
    lon: d.lon,
    lat: d.lat,
  }));
  const free = (c: (typeof cars)[number]) => c.car.capacity - c.car.passengers.length;
  const unseated: CarpoolPlan['unseated'] = [];

  for (const p of passengers) {
    const open = cars.filter((c) => free(c) > 0);
    // Même parking d'abord (la voiture la moins chargée), sinon le parking le plus proche.
    const same = open.filter((c) => c.car.destination === p.destination).sort((a, b) => free(b) - free(a));
    const target = same[0]
      ?? open.slice().sort((a, b) => distance(a, p) - distance(b, p) || free(b) - free(a))[0];
    if (!target) {
      unseated.push({ id: p.id, name: p.name, destinationName: p.destinationName });
      continue;
    }
    target.car.passengers.push({ id: p.id, name: p.name, destinationName: p.destinationName, detour: target.car.destination !== p.destination });
  }
  return {
    cars: cars.map((c) => c.car),
    unseated,
    carsAdvised: Math.ceil(people.length / maxPerCar),
    maxPerCar,
  };
}
