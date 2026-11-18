// Vérification de bout en bout : aucune page principale n'affiche « null » ou
// « undefined », pour chaque rôle. À lancer avec l'API et le site en local
// (mode d'authentification dev) : node web/e2e/no-null.cjs
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const PAGES = ['#/', '#/journees', '#/territoires', '#/lieux', '#/plans', '#/membres', '#/parametres', '#/profil', '#/notifications'];
const USERS = [['marc', 'président'], ['paul', 'chasseur']];

(async () => {
  const browser = await chromium.launch();
  let failures = 0;
  for (const [user, role] of USERS) {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${BASE}/`);
    await page.evaluate((u) => localStorage.setItem('chassestu.devUser', JSON.stringify({ id: u, name: u })), user);
    for (const hash of PAGES) {
      await page.goto(`${BASE}/${hash}`);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(600);
      const text = await page.locator('main').innerText().catch(() => '');
      const bad = text.match(/\b(null|undefined|NaN|\[object Object\])\b/);
      if (bad) {
        failures += 1;
        console.log(`✗ ${role} ${hash} : « ${bad[0]} » … ${text.slice(Math.max(0, bad.index - 60), bad.index + 40).replace(/\s+/g, ' ')}`);
      }
    }
  }
  console.log(failures ? `${failures} page(s) en défaut` : 'Aucune page n’affiche null / undefined.');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
