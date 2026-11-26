// Infos de chasse d'une saison (règlement) : schéma du document JSON.
// Tout est du texte affiché échappé ; les règles utilisent un balisage
// minimal (paragraphes, « - » listes, **gras**), jamais du HTML.
import { z } from 'zod';

const txt = (max: number) => z.string().max(max);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide (AAAA-MM-JJ).');
const key = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Identifiant invalide (lettres, chiffres, - et _).');
const bound = z.string().regex(/^(\d\d:\d\d|[rs][+-]\d{1,3})$/, 'Horaire invalide : HH:MM, r±minutes (lever) ou s±minutes (coucher).');

const period = z.object({
  from: day, to: day, days: key, hours: key,
  where: txt(100).optional(), cond: txt(1000).optional(), restricted: z.boolean().optional(),
}).strict();

const species = z.object({
  id: key, cat: key, name: txt(120).min(1), sub: txt(200).optional(), src: txt(100).optional(),
  kind: z.enum(['check', 'suspended']).optional(), checkText: txt(1000).optional(),
  battue: key.optional(), plan: txt(500).optional(), noPlan: z.boolean().optional(),
  limit: txt(200).optional(), limitFull: txt(1500).optional(),
  notes: z.array(txt(1000)).max(30).default([]),
  periods: z.array(period).max(20).default([]),
}).strict();

export const regulationsSchema = z.object({
  version: z.literal(1),
  title: txt(200),
  season_label: txt(40).optional(),
  reference: z.object({ name: txt(100), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict(),
  campaign: z.object({ from: day, to: day, before_text: txt(300).optional(), after_text: txt(300).optional() }).strict(),
  chart: z.object({ from: day, to: day }).strict().optional(),
  categories: z.array(z.object({ id: key, label: txt(100) }).strict()).max(20),
  days: z.record(key, z.object({ label: txt(100), dow: z.array(z.number().int().min(0).max(6)).max(7), holidays: z.boolean().optional() }).strict()),
  hours: z.record(key, z.object({ seg: z.array(z.tuple([bound, bound])).min(1).max(4), label: txt(200) }).strict()),
  species: z.array(species).max(100),
  battues: z.array(z.object({ date: day, game: key, leader: txt(100) }).strict()).max(500),
  battue_notice: txt(1000).optional(),
  notices: z.array(z.object({ from: day, to: day, title: txt(200), text: txt(1500) }).strict()).max(50),
  day_hint: txt(500).optional(),
  day_footer: txt(2000).optional(),
  season_footer: txt(2000).optional(),
  checklist: z.array(z.object({ id: key, label: txt(200) }).strict()).max(30),
  rules: z.array(z.object({ title: txt(200), text: txt(10000), open: z.boolean().optional() }).strict()).max(40),
}).strict().superRefine((r, ctx) => {
  // Références internes : catégories, règles de jours, horaires.
  const cats = new Set(r.categories.map((c) => c.id));
  r.species.forEach((e, i) => {
    if (!cats.has(e.cat)) ctx.addIssue({ code: 'custom', path: ['species', i, 'cat'], message: `Catégorie inconnue : ${e.cat}` });
    e.periods.forEach((p, j) => {
      if (!r.days[p.days]) ctx.addIssue({ code: 'custom', path: ['species', i, 'periods', j, 'days'], message: `Jours inconnus : ${p.days}` });
      if (!r.hours[p.hours]) ctx.addIssue({ code: 'custom', path: ['species', i, 'periods', j, 'hours'], message: `Horaires inconnus : ${p.hours}` });
      if (p.to < p.from) ctx.addIssue({ code: 'custom', path: ['species', i, 'periods', j, 'to'], message: `${e.name} : période qui finit avant de commencer` });
    });
  });
});
export type Regulations = z.infer<typeof regulationsSchema>;
