// Captures d'écran du manuel d'utilisation (api/manuel/captures/*.png), à refaire quand les écrans changent.
// 1. Lancer l'application en démo sur un port libre :  PORT=3199 npm run memoire
// 2. Puis :  BASE=http://localhost:3199 npm run manuel:captures
// Navigateur : Microsoft Edge ou Chrome installé (playwright-core, sans téléchargement).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:3199';
const API = `${BASE}/api`;
const ENT = 'DEM-000-000-001';
const DOSSIER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'captures');
fs.mkdirSync(DOSSIER, { recursive: true });

const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const connexion = async (email, code = '1234') =>
  (await json(await fetch(`${API}/auth/connexion`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entreprise: ENT, email, motDePasse: code }) }))).jeton;
const appel = async (j, m, u, corps, depot = 'PAR') => json(await fetch(API + u, {
  method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${j}`, ...(depot ? { 'x-depot': depot } : {}) }, body: corps ? JSON.stringify(corps) : undefined,
}));

// ── Données d'exemple ──
const [admin, rec, car, quai] = await Promise.all(['admin@colis.local', 'reception@colis.local', 'cariste@colis.local', 'quai@colis.local'].map((e) => connexion(e)));
await appel(admin, 'PUT', '/parametres', { nomApplication: 'Gestion colis' }, null);
const personnes = [['DIALLO Awa', '0601020304', 'KOUASSI Jean', '+225 07 12 34 56 78'], ['TRAORE Moussa', '0611223344', 'KONE Aminata', '+225 05 44 33 22 11'],
  ['MENDY Paul', '0622334455', 'BAMBA Issa', '+225 01 23 45 67 89'], ['SOW Fatou', '0633445566', 'DIOP Khady', '+221 77 123 45 67']];
const colis = [];
for (const [i, [en, et, dn, dt]] of personnes.entries()) {
  colis.push(await appel(rec, 'POST', '/colis', {
    destination: i === 3 ? 'DKR' : 'ABJ', poidsKg: 8 + i * 3, nbPieces: 1, description: ['Vêtements', 'Électroménager', 'Pièces auto', 'Alimentaire'][i],
    expediteur: { nom: en, tel: et }, destinataire: { nom: dn, tel: dt, adresse: 'Cocody, Abidjan' }, paiement: { mode: 'ESPECES' },
  }));
}
const pal = await appel(car, 'POST', '/palettes', { destination: 'ABJ' });
for (const c of colis.slice(0, 2)) await appel(car, 'POST', `/palettes/${pal.numero}/colis`, { numero: c.numero });
const pal2 = await appel(car, 'POST', '/palettes', { destination: 'ABJ' });
await appel(car, 'POST', `/palettes/${pal2.numero}/colis`, { numero: colis[2].numero });
await appel(car, 'POST', `/palettes/${pal2.numero}/fermer`);
await appel(quai, 'POST', `/palettes/${pal2.numero}/zone-depart`);
const ctn = await appel(quai, 'POST', '/conteneurs', { destination: 'ABJ', type: "20'" });
const nouveau = await appel(admin, 'POST', '/utilisateurs', { email: 'nouvel.agent@colis.local', nom: 'Nouvel agent', role: 'RECEPTION', depots: ['PAR'] }, null);

// ── Captures ──
const navigateur = await chromium.launch({ channel: process.env.NAVIGATEUR ?? 'msedge' });
const contexte = async () => navigateur.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 });
const masquerDemo = (p) => p.addStyleTag({ content: '.profils, .separateur, .lien-demo, .toast { display: none !important; }' });
const capture = async (p, nom, cible) => {
  await p.waitForTimeout(500);
  await (cible ? p.locator(cible).first() : p).screenshot({ path: path.join(DOSSIER, `${nom}.png`) });
  console.log('capture', nom);
};
const pave = async (p, code) => { for (const c of code) await p.click(`app-clavier-code .touche:text-is("${c}")`); };
const session = async (email) => {
  const c = await contexte();
  const p = await c.newPage();
  await p.goto(`${BASE}/connexion/${ENT}`); await p.waitForSelector('app-clavier-code');
  await p.fill('input[name="email"]', email); await pave(p, '1234'); await p.waitForSelector('aside.barre');
  return p;
};

// Connexion
{
  const p = await (await contexte()).newPage();
  await p.goto(`${BASE}/connexion`); await p.waitForSelector('input[name="ent"]'); await masquerDemo(p);
  await p.locator('input[name="ent"]').pressSequentially(ENT.replaceAll('-', ''));
  await capture(p, '01-connexion-identifiant');
  await p.goto(`${BASE}/connexion/${ENT}`); await p.waitForSelector('app-clavier-code'); await masquerDemo(p);
  await p.fill('input[name="email"]', 'admin@colis.local'); await pave(p, '12');
  await capture(p, '02-connexion-code');
  // Premier accès avec le code provisoire : choix du code personnel
  await p.fill('input[name="email"]', 'nouvel.agent@colis.local'); await p.click('app-clavier-code .touche[title="Tout effacer"]').catch(() => {});
  await p.locator('input[name="email"]').press('Tab'); await p.keyboard.type(nouveau.codeProvisoire);
  await p.waitForURL('**/mot-de-passe'); await p.keyboard.type('58');
  await capture(p, '03-choix-du-code');
}

// Administration
{
  const p = await session('admin@colis.local');
  await p.goto(`${BASE}/admin`); await p.waitForSelector('.onglets');
  await capture(p, '10-admin-depots');
  await p.click('.onglets button:has-text("Destinations")'); await capture(p, '11-admin-destinations');
  await p.click('.onglets button:has-text("Modes de paiement")'); await capture(p, '12-admin-paiements');
  await p.click('.onglets button:has-text("Utilisateurs")'); await p.waitForSelector('table'); await capture(p, '13-admin-utilisateurs');
  await p.click('button:has-text("Nouveau compte")'); await p.fill('.popup input[name="nom"]', 'Mariam Touré'); await p.fill('.popup input[name="email"]', 'mariam@exemple.com');
  await capture(p, '14-admin-nouveau-compte'); await p.click('.popup button:has-text("Annuler")');
  await p.click('.onglets button:has-text("Paramètres")'); await p.waitForSelector('app-identite-entreprise .identite');
  // Manuel destiné à l'établissement : sans les réglages techniques d'envoi des e-mails
  await p.addStyleTag({ content: 'app-reglages-smtp { display: none !important; }' });
  await capture(p, '15-admin-parametres');
  await p.goto(`${BASE}/admin`); await p.click('.onglets button:has-text("Dépôts")'); await p.locator('table tr').nth(1).locator('button:has-text("Modifier")').click().catch(() => {});
  await capture(p, '17-admin-imprimante');
  await p.goto(`${BASE}/contact`); await p.waitForSelector('app-contact form'); await capture(p, '40-contact');
}

// Réception
{
  const p = await session('reception@colis.local');
  await p.goto(`${BASE}/reception`); await p.waitForSelector('input[name="et"]');
  await p.fill('input[name="et"]', '0644556677'); await p.fill('input[name="en"]', 'CISSE Adama');
  await p.fill('input[name="dt"]', '+225 07 98 76 54 32'); await p.fill('input[name="dn"]', 'YAO Koffi'); await p.fill('input[name="da"]', 'Yopougon, Abidjan');
  await p.selectOption('select[name="dest"]', 'ABJ'); await p.locator('input[type=number][step="0.1"]').first().fill('15');
  await capture(p, '20-reception');
  await p.click('form.mise-en-page button.valider'); await p.waitForSelector('app-etiquette-colis .papier');
  await capture(p, '21-reception-etiquette');
  await p.goto(`${BASE}/suivi`); await p.waitForTimeout(800); await capture(p, '30-suivi');
}

// Palettisation, zone de départ, chargement, scan
{
  const p = await session('quai@colis.local');
  await p.goto(`${BASE}/palettisation`); await p.waitForSelector('.liste-palettes');
  await p.locator(`.carte-palette:has-text("${pal.numero}")`).click(); await p.waitForTimeout(600);
  await capture(p, '22-palettisation');
  await p.goto(`${BASE}/zone-depart`); await p.waitForTimeout(800); await capture(p, '23-zone-depart');
  await p.goto(`${BASE}/chargement`); await p.waitForTimeout(800);
  await p.locator(`:text("${ctn.numero}")`).first().click().catch(() => {}); await p.waitForTimeout(800);
  await capture(p, '24-chargement');
  await p.goto(`${BASE}/scan`); await p.waitForSelector('app-scan-input input');
  await p.fill('app-scan-input input', colis[0].numero); await p.press('app-scan-input input', 'Enter'); await p.waitForTimeout(900);
  await capture(p, '31-scan');
  await p.goto(`${BASE}/douchette`); await p.waitForTimeout(600); await capture(p, '32-douchette');
}

await navigateur.close();
console.log(`Captures enregistrées dans ${DOSSIER}`);
