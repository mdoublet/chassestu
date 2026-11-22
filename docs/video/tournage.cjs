// Tournage du guide vidéo du président : une seule prise continue, scènes
// calées sur la durée de leur narration (voix/<id>.wav). Produit
// out/brut.webm et out/timeline.json (début de chaque scène, en secondes).
// FAST=1 : répétition sans attentes de narration ni vidéo (mise au point).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const BASE = 'http://localhost:5173';
const FAST = process.env.FAST === '1';
const ONLY = process.env.UNTIL; // s'arrêter après cette scène
const durs = JSON.parse(fs.readFileSync(path.join(DIR, 'durations.json'), 'utf8'));
const OUT = path.join(DIR, 'out');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? Math.min(ms, 150) : ms));

// Curseur visible (pastille qui suit la souris, s'enfonce au clic).
const cursorInit = () => {
  const add = () => {
    if (document.getElementById('demo-cursor')) return;
    const st = document.createElement('style');
    st.textContent = `#demo-cursor{position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;
      background:rgba(232,89,12,.35);border:2px solid #e8590c;pointer-events:none;transition:transform .12s;left:-50px;top:-50px}
      #demo-cursor.down{transform:scale(.6);background:rgba(232,89,12,.7)}`;
    document.head.append(st);
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    document.body.append(c);
    document.addEventListener('mousemove', (e) => { c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`; }, true);
    document.addEventListener('mousedown', () => c.classList.add('down'), true);
    document.addEventListener('mouseup', () => c.classList.remove('down'), true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    ...(FAST ? {} : { recordVideo: { dir: OUT, size: { width: 1280, height: 720 } } }),
  });
  await ctx.addInitScript(() => localStorage.setItem('chassestu.devUser', JSON.stringify({ id: 'michel', name: 'Michel' })));
  await ctx.addInitScript(cursorInit);
  const page = await ctx.newPage();
  const rec0 = Date.now();
  const timeline = {};
  let mouse = { x: 640, y: 360 };

  // --- Gestes « humains » -------------------------------------------------
  async function moveTo(x, y) {
    await page.mouse.move(x, y, { steps: FAST ? 2 : 16 });
    mouse = { x, y };
    await sleep(180);
  }
  async function center(loc) {
    // Le panneau se redessine souvent (rechargements) : on réessaie.
    for (let i = 0; ; i++) {
      try {
        await loc.waitFor({ state: 'visible', timeout: 20000 });
        await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
        await sleep(120);
        const b = await loc.boundingBox();
        if (b) return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      } catch (err) {
        if (i >= 4) throw err;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  async function click(loc, pause = 500) {
    const { x, y } = await center(loc);
    await moveTo(x, y);
    await page.mouse.click(x, y);
    await sleep(pause);
  }
  async function hover(loc, pause = 700) {
    const { x, y } = await center(loc);
    await moveTo(x, y);
    await sleep(pause);
  }
  async function type(loc, text, { clear = true, enter = false } = {}) {
    await click(loc, 200);
    if (clear) await loc.fill('');
    await loc.pressSequentially(text, { delay: FAST ? 0 : 55 });
    if (enter) await loc.press('Enter');
    else await loc.press('Tab');
    await sleep(400);
  }
  async function choose(loc, option) {
    // Survol puis choix (la liste native ne s'affiche pas dans la vidéo).
    await hover(loc, 350);
    await loc.selectOption(option);
    await sleep(700);
  }
  async function mapPoint(mapVar, lonlat) {
    return page.evaluate(([v, [lon, lat]]) => {
      const m = window[v];
      const r = m.getContainer().getBoundingClientRect();
      const p = m.latLngToContainerPoint([lat, lon]);
      return { x: r.left + p.x, y: r.top + p.y };
    }, [mapVar, lonlat]);
  }
  async function mapClick(mapVar, lonlat, pause = 450) {
    const { x, y } = await mapPoint(mapVar, lonlat);
    await moveTo(x, y);
    await page.mouse.click(x, y);
    await sleep(pause);
  }
  /** Ouvre un bloc dépliable (clic sur son titre ; vérifié). */
  async function openFold(title, pause = 600) {
    const sum = page.locator('details > summary', { hasText: title }).first();
    await click(sum, 300);
    const open = await sum.evaluate((el) => el.parentElement.open);
    if (!open) await sum.evaluate((el) => { el.parentElement.open = true; });
    await sleep(pause);
  }
  const nav = (label) => click(page.locator('header nav a', { hasText: label }).first(), 1200);
  const dialogInput = () => page.locator('dialog[open] input').first();
  const dialogButton = (label) => page.locator('dialog[open] button', { hasText: label }).first();
  const api = (who, method, url, body) => page.evaluate(async ([w, m, u, b]) => {
    const t = localStorage.getItem('chassestu.tenantId');
    const r = await fetch(u, { method: m, headers: { Authorization: `Bearer dev:${w}`, 'X-Tenant-Id': t, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return r.status === 204 ? null : r.json();
  }, [who, method, url, body]);

  /** Scène : actions, puis attente jusqu'à la fin de sa narration (+ un souffle). */
  async function scene(id, fn) {
    const t0 = (Date.now() - rec0) / 1000;
    timeline[id] = t0;
    console.log(`▶ ${id} (${t0.toFixed(1)} s)`);
    await fn();
    const elapsed = (Date.now() - rec0) / 1000 - t0;
    const rest = (durs[id] ?? 0) + 0.9 - elapsed;
    if (rest > 0) await sleep(rest * 1000);
    if (ONLY === id) throw new Error('STOP');
  }

  try {
    // ------------------------------------------------------------------------
    await scene('intro', async () => {
      await page.goto(`${BASE}/#/journees`);
      await page.waitForSelector('h1');
      await page.evaluate(() => {
        const o = document.createElement('div');
        o.id = 'title-card';
        o.innerHTML = '<div><div style="font-size:64px">🎯</div><h1 style="font-size:52px;margin:.2em 0">Chasses-tu ?</h1><p style="font-size:28px;margin:0">Guide du président</p><p style="font-size:20px;opacity:.8;margin-top:1.2em">Configuration · Territoires · Plans de chasse · Une journée de chasse</p></div>';
        Object.assign(o.style, { position: 'fixed', inset: '0', zIndex: '99999', display: 'grid', placeItems: 'center', textAlign: 'center', color: '#fff', background: 'linear-gradient(135deg,#1f5130,#2f6b44)', fontFamily: 'system-ui,sans-serif' });
        document.body.append(o);
      });
    });
    await page.evaluate(() => document.getElementById('title-card')?.remove());

    // ------------------------------------------------------------------------
    await scene('profil', async () => {
      await nav('Mon profil');
      await type(page.locator('label:has-text("Nom") input').first(), 'Michel Durand');
      await choose(page.locator('label:has-text("Marche") select'), '4');
      await click(page.locator('label:has-text("Ma voiture") input'));
      await type(page.locator('label:has-text("Places libres") input'), '3');
      await click(page.locator('form button.primary:has-text("Enregistrer")'), 1200);
    });

    await scene('parametres', async () => {
      await nav('Paramètres');
      await hover(page.locator('select[aria-label="Saison en cours"]'), 1500);
      await hover(page.locator('label:has-text("Nom") input').first(), 1200);
      await openFold('Sécurité', 700);
      await hover(page.locator('input[name="buffer_distance_m"]'), 1500);
    });

    await scene('especes', async () => {
      await openFold('Espèces et quotas', 600);
      const rows = page.locator('.species-table tbody tr');
      await type(rows.nth(0).locator('input').nth(1), '40');
      await type(rows.nth(0).locator('input').nth(2), '4');
      await type(rows.nth(1).locator('input').nth(1), '12');
      await type(rows.nth(1).locator('input').nth(2), '2');
      await click(page.locator('section.card:has(summary:has-text("Espèces et quotas")) button.primary'), 1200);
      await openFold('Prélèvements de la saison', 800);
      await hover(page.locator('ul.recap li').first(), 800);
    });

    // ------------------------------------------------------------------------
    await scene('lieux', async () => {
      await nav('Lieux');
      await click(page.locator('button:has-text("+ Nouveau lieu")'));
      await type(page.locator('form label:has-text("Nom") input'), 'Cabane de chasse');
      await choose(page.locator('form label:has-text("Type") select'), 'cabane');
      await page.evaluate((d) => window.__placesMap.flyTo([43.4185, 2.2005], 15, { duration: d }), FAST ? 0.2 : 1.6);
      await sleep(2200);
      await click(page.locator('button:has-text("Placer sur la carte")'));
      await mapClick('__placesMap', [2.2005, 43.4185], 700);
      await click(page.locator('form button.primary:has-text("Ajouter")'), 1500);
    });

    // ------------------------------------------------------------------------
    await scene('territoire', async () => {
      await nav('Territoires');
      await click(page.locator('a:has-text("+ Nouveau territoire")'), 900);
      await type(dialogInput(), 'Bois de la Garrigue', { enter: false });
      await click(dialogButton('Valider'), 1800);
      const corners = [[2.186, 43.4265], [2.211, 43.4305], [2.2215, 43.4165], [2.206, 43.4065], [2.1845, 43.4115]];
      for (const c of corners) await mapClick('__map', c, 550);
      await mapClick('__map', corners[0], 900);
      // Import des bâtiments IGN : jusqu'au résumé « Non chassable ».
      await page.waitForSelector('section.zone-summary', { timeout: 90000 }).catch(() => {});
      await sleep(2500);
    });

    await scene('postes', async () => {
      await click(page.locator('aside button:has-text("+ Parking")'), 400);
      await mapClick('__map', [2.1992, 43.4176], 700);
      await type(dialogInput(), 'Parking du col');
      await click(dialogButton('Valider'), 1500);
      const posts = [[2.1925, 43.4232], [2.2045, 43.4262], [2.2135, 43.4198], [2.2095, 43.4108], [2.1955, 43.4135], [2.2025, 43.4205]];
      for (const p of posts) {
        await click(page.locator('aside button:has-text("+ Poste")'), 350);
        await mapClick('__map', p, 600);
        await page.waitForFunction(() => /Chemin de \d+ m|parking/.test(document.querySelector('#toast')?.textContent ?? ''), null, { timeout: 25000 }).catch(() => {});
        await sleep(900);
      }
    });

    await scene('fiche', async () => {
      await openFold('Postes', 600);
      await click(page.locator('details.fold li.obj-row button[title="Modifier"]').first(), 900);
      await type(page.locator('section.props label:has-text("Nom") input'), 'Le grand chêne');
      await hover(page.locator('section.props label:has-text("Ligne") select'), 1200);
      await choose(page.locator('section.props label:has-text("Difficulté") select'), '3');
      await openFold('Consignes', 400);
      await type(page.locator('section.props textarea').first(), 'Tir uniquement vers le bas de la combe.');
      await hover(page.locator('details.fold li.obj-row').nth(2), 1200);
    });

    // ------------------------------------------------------------------------
    await scene('plans', async () => {
      await nav('Territoires');
      await click(page.locator('a:has-text("Plans de chasse")').first(), 1500);
      await click(page.locator('button:has-text("Créer un plan de chasse")'), 700);
      await type(dialogInput(), 'Traque du ruisseau');
      await click(dialogButton('Valider'), 1500);
      const traque = [[2.1875, 43.4155], [2.1985, 43.4185], [2.2075, 43.4165], [2.2165, 43.4175]];
      for (const p of traque) await mapClick('__plansMap', p, 600);
      await mapClick('__plansMap', traque[traque.length - 1], 1500);
    });

    await scene('grille', async () => {
      const addCount = async (n) => {
        const sel = page.locator('.add-row select');
        const label = await sel.locator('option', { hasText: new RegExp(`^${n} chasseurs`) }).first().textContent();
        await choose(sel, { label });
      };
      await addCount(4);
      const row = () => page.locator('table.plans tr.selected');
      for (let i = 0; i < 4; i++) await click(row().locator('input[type=checkbox]').nth(i), 350);
      await click(row().locator('button:has-text("Enregistrer")'), 1300);
      await addCount(5);
      await click(row().locator('input[type=checkbox]').nth(4), 500);
      await click(row().locator('button:has-text("Enregistrer")'), 1300);
    });

    // ------------------------------------------------------------------------
    await scene('journee', async () => {
      await nav('Journées');
      await click(page.locator('button:has-text("+ Nouvelle journée")'), 2200);
      { const t = page.locator('input[name="meeting_time"]'); await click(t, 300); await t.fill('07:30'); await t.dispatchEvent('change'); await sleep(900); }
      await choose(page.locator('label:has-text("Choisir le lieu du rendez-vous") select'), { label: '🛖 Cabane de chasse' });
      await click(page.locator('label:has-text("Déjeuner proposé") input'), 1200);
      await type(page.locator('input[name="lunch_info"]'), 'Salle des fêtes, 15 €');
    });

    await scene('convocations', async () => {
      await hover(page.locator('summary:has-text("Convocations")'), 600);
      await click(page.locator('ul.members label:has-text("André") input'), 1300);
      await hover(page.locator('summary:has-text("Traqueurs")'), 700);
      await click(page.locator('button:has-text("Envoyer les convocations")'), 1500);
    });

    // Difficultés d'accès réalistes des autres postes (hors champ).
    { const t = (await api('michel:Michel', 'GET', '/api/territories')).territories[0];
      const full = await api('michel:Michel', 'GET', `/api/territories/${t.id}`);
      const diff = { 2: 2, 3: 3, 4: 2, 5: 1, 6: 2 };
      for (const p of full.posts) if (diff[p.number]) await api('michel:Michel', 'PATCH', `/api/posts/${p.id}`, { access_difficulty: diff[p.number] }); }
    // Les chasseurs répondent depuis leur téléphone (hors champ).
    const dayId = (await page.evaluate(() => location.hash)).split('/').pop();
    for (const u of ['michel:Michel', 'jean:Jean', 'paul:Paul', 'luc:Luc', 'pierre:Pierre', 'sophie:Sophie', 'marc:Marc']) {
      await api(u, 'POST', `/api/days/${dayId}/respond`, { response: 'present', lunch: u !== 'marc:Marc' });
    }

    await scene('jourj', async () => {
      await page.reload();
      await page.waitForSelector('button:has-text("Commencer la journée")');
      await hover(page.locator('summary:has-text("Convocations")'), 900);
      await click(page.locator('button:has-text("Commencer la journée")'), 2000);
      await choose(page.locator('label:has-text("Plan de chasse") select'), { label: 'Traque du ruisseau' });
      await click(page.locator('button:has-text("Créer la battue")'), 2500);
      await page.waitForFunction(() => document.querySelectorAll('.assign-list .chips button').length >= 5, null, { timeout: 20000 }).catch(() => {});
    });

    await scene('placement', async () => {
      await hover(page.locator('summary:has-text("2. Postes")'), 900);
      // Déplacer Paul (échange avec l'occupant).
      await click(page.locator('.assign-list .chip', { hasText: 'Paul' }), 700);
      await click(page.locator('.assign-list li.assign-row').nth(1), 1500);
      await choose(page.locator('select[aria-label="Responsable de battue"]'), { label: 'Jean' });
      await click(page.locator('button:has-text("Publier les postes")'), 1800);
    });

    // Les postés confirment « Je suis en place » (hors champ).
    const huntId = (await api('michel:Michel', 'GET', `/api/days/${dayId}`)).battues.at(-1).id;
    for (const u of ['michel:Michel', 'jean:Jean', 'paul:Paul', 'luc:Luc', 'pierre:Pierre']) await api(u, 'PUT', `/api/hunts/${huntId}/in-place`, { in_place: true });

    await scene('traque', async () => {
      await page.reload();
      await page.waitForSelector('.battue-actions');
      await hover(page.locator('summary:has-text("5. Mise en place")'), 1200);
      await click(page.locator('.battue-actions button:has-text("Lancer la battue")'), 2000);
      const step = page.locator('section.step-prelev');
      await choose(step.locator('select[aria-label="Tué, blessé ou vu"]'), 'tue');
      await choose(step.locator('select[aria-label="Espèce"]'), 'Sanglier');
      await choose(step.locator('select[aria-label="Catégorie"]'), 'male');
      await choose(step.locator('select[aria-label="Tireur"]'), { label: 'Luc' });
      await click(step.locator('button:has-text("Déclarer")'), 1500);
    });

    await scene('fin', async () => {
      await click(page.locator('.battue-actions button:has-text("Fin de battue")'), 800);
      await click(dialogButton('Confirmer'), 2000);
      await choose(page.locator('section.regroup select').first(), { label: '🛖 Cabane de chasse' });
      await click(page.locator('button:has-text("Annoncer le regroupement")'), 1800);
    });

    await scene('recap', async () => {
      await nav('Paramètres');
      await openFold('Prélèvements de la saison', 600);
      await hover(page.locator('ul.recap li').first(), 1500);
    });
  } catch (err) {
    if (err.message !== 'STOP') {
      console.log('ÉCHEC', err.message.split('\n').slice(0, 4).join(' / '));
      await page.screenshot({ path: path.join(OUT, 'echec.png') });
    }
  }
  fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({ ...timeline, end: (Date.now() - rec0) / 1000 }, null, 1));
  const video = page.video();
  await ctx.close();
  if (video) fs.renameSync(await video.path(), path.join(OUT, 'brut.webm'));
  await browser.close();
})();
