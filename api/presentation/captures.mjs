// Captures d'écran de la vidéo de présentation (api/presentation/captures/*.png, 1920 × 1080).
// 1. Lancer l'application en démo sur un port libre :  PORT=3199 npm run memoire
// 2. Puis :  BASE=http://localhost:3199 node presentation/captures.mjs
// 3. Enfin :  python presentation/video.py  (voix + diapositives → presentation/presentation.mp4)
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
const appel = async (j, m, u, corps, depot = 'PAR') => {
  const r = await json(await fetch(API + u, {
    method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${j}`, ...(depot ? { 'x-depot': depot } : {}) }, body: corps ? JSON.stringify(corps) : undefined,
  }));
  if (r?.code && r?.message) console.warn(`  ${m} ${u} → ${r.code} : ${r.message}`);
  return r;
};
const dans = (jours) => new Date(Date.now() + jours * 86400000).toISOString().slice(0, 10);

// ── Données d'exemple ──
const [admin, rec, car, quai] = await Promise.all(['admin@colis.local', 'reception@colis.local', 'cariste@colis.local', 'quai@colis.local'].map((e) => connexion(e)));
await appel(admin, 'PUT', '/parametres', { nomApplication: 'Gestion colis' }, null);
await appel(admin, 'POST', '/codes-promo', { code: 'BIENVENUE10', pourcentage: 10, debut: dans(0), fin: dans(60), description: 'Offre de bienvenue' }, null);
await appel(admin, 'POST', '/codes-promo', { code: 'FIDELITE15', pourcentage: 15, debut: dans(0), fin: dans(30), utilisationsMax: 100, description: 'Clients fidèles' }, null);
await appel(admin, 'POST', '/codes-promo', { code: 'RENTREE20', pourcentage: 20, debut: dans(0), fin: dans(15), utilisationsMax: 50, description: 'Offre de rentrée' }, null);

const personnes = [
  ['DIALLO Awa', '0601020304', 'awa.diallo@exemple.fr', 'KOUASSI Jean', '+225 07 12 34 56 78', 'ABJ'],
  ['TRAORE Moussa', '0611223344', 'moussa.traore@exemple.fr', 'KONE Aminata', '+225 05 44 33 22 11', 'ABJ'],
  ['MENDY Paul', '0622334455', 'paul.mendy@exemple.fr', 'BAMBA Issa', '+225 01 23 45 67 89', 'ABJ'],
  ['SOW Fatou', '0633445566', 'fatou.sow@exemple.fr', 'DIOP Khady', '+221 77 123 45 67', 'DKR'],
  ['KEITA Ibrahim', '0644112233', 'ibrahim.keita@exemple.fr', 'YAO Koffi', '+225 07 98 76 54 32', 'ABJ'],
  ['NDIAYE Marie', '0655667788', 'marie.ndiaye@exemple.fr', 'FALL Cheikh', '+221 76 555 44 33', 'DKR'],
  ['COULIBALY Seydou', '0666778899', 'seydou.c@exemple.fr', 'OUATTARA Ali', '+225 05 11 22 33 44', 'ABJ'],
];
const colis = [];
for (const [i, [en, et, ee, dn, dt, dest]] of personnes.entries()) {
  const e = await appel(rec, 'POST', '/envois', {
    destination: dest, expediteur: { nom: en, tel: et, email: ee }, destinataire: { nom: dn, tel: dt, adresse: dest === 'ABJ' ? 'Cocody, Abidjan' : 'Plateau, Dakar' },
    colis: [{ poidsKg: 8 + i * 3, description: ['Vêtements', 'Électroménager', 'Pièces auto', 'Alimentaire', 'Livres', 'Cosmétiques', 'Matériel informatique'][i],
      options: i % 2 === 0 ? [{ libelle: 'Emballage renforcé', montant: 5 }] : [] }],
    codePromo: i % 3 === 0 ? 'BIENVENUE10' : '', offres: { accepte: true, email: ee }, paiement: { mode: 'ESPECES' },
  });
  colis.push(...(e.colis ?? []));
}
const abj = colis.filter((c) => c.destination === 'ABJ');
// Palette ouverte en cours de remplissage
const pal = await appel(car, 'POST', '/palettes', { destination: 'ABJ' });
for (const c of abj.slice(0, 2)) await appel(car, 'POST', `/palettes/${pal.numero}/colis`, { numero: c.numero });
// Palette fermée, en attente de mise en zone de départ
const pal2 = await appel(car, 'POST', '/palettes', { destination: 'ABJ' });
await appel(car, 'POST', `/palettes/${pal2.numero}/colis`, { numero: abj[2].numero });
await appel(car, 'POST', `/palettes/${pal2.numero}/fermer`);
// Palette en zone de départ, puis chargée dans le conteneur
const pal3 = await appel(car, 'POST', '/palettes', { destination: 'ABJ' });
for (const c of abj.slice(3, 5)) await appel(car, 'POST', `/palettes/${pal3.numero}/colis`, { numero: c.numero });
await appel(car, 'POST', `/palettes/${pal3.numero}/fermer`);
await appel(quai, 'POST', `/palettes/${pal3.numero}/zone-depart`);
const ctn = await appel(quai, 'POST', '/conteneurs', { destination: 'ABJ', type: "40' HC", numeroOfficiel: 'MSKU1234567' });
await appel(quai, 'POST', `/conteneurs/${ctn.numero}/palettes`, { code: pal3.numero });

// ── Captures ──
const navigateur = await chromium.launch({ channel: process.env.NAVIGATEUR ?? 'msedge' });
const contexte = async () => navigateur.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2 });
const masquer = (p) => p.addStyleTag({ content: '.profils, .separateur, .lien-demo, .toast, .bandeau-licence { display: none !important; }' });
const capture = async (p, nom) => {
  await p.waitForTimeout(700);
  await p.screenshot({ path: path.join(DOSSIER, `${nom}.png`) });
  console.log('capture', nom);
};
const pave = async (p, code) => { for (const c of code) await p.click(`app-clavier-code .touche:text-is("${c}")`); };
const session = async (email) => {
  const p = await (await contexte()).newPage();
  await p.goto(`${BASE}/connexion/${ENT}`); await p.waitForSelector('app-clavier-code');
  await p.fill('input[name="email"]', email); await pave(p, '1234'); await p.waitForSelector('aside.barre');
  return p;
};

// Connexion
{
  const p = await (await contexte()).newPage();
  await p.goto(`${BASE}/connexion/${ENT}`); await p.waitForSelector('app-clavier-code'); await masquer(p);
  await p.fill('input[name="email"]', 'reception@colis.local'); await pave(p, '12');
  await capture(p, '01-connexion');
}

// Réception : expéditeur, destinataire, poids, option, code promo, consentement aux offres
{
  const p = await session('reception@colis.local');
  await p.goto(`${BASE}/reception`); await p.waitForSelector('input[name="et"]'); await masquer(p);
  await p.fill('input[name="et"]', '0677889900'); await p.fill('input[name="en"]', 'CISSE Adama');
  await p.fill('input[name="ee"]', 'adama.cisse@exemple.fr'); await p.check('input[name="eo"]');
  await p.fill('input[name="dt"]', '+225 07 98 76 54 32'); await p.fill('input[name="dn"]', 'YAO Koffi'); await p.fill('input[name="da"]', 'Yopougon, Abidjan');
  await p.selectOption('select[name="dest"]', 'ABJ'); await p.locator('input[type=number][step="0.1"]').first().fill('15');
  await p.click('.ligne-colis .ajout-option'); await p.locator('.option-colis input').nth(0).fill('Emballage renforcé');
  await p.locator('.option-colis input').nth(1).fill('5');
  await p.fill('input[name="promo"]', 'BIENVENUE10'); await p.click('.promo button:has-text("Appliquer")'); await p.waitForSelector('.promo-ok');
  await capture(p, '02-reception');
  await p.click('form.mise-en-page button.valider'); await p.waitForSelector('app-etiquette-colis .papier');
  await capture(p, '03-etiquette');
}

// Palettisation, zone de départ, chargement et validation
{
  const p = await session('quai@colis.local');
  await masquer(p);
  await p.goto(`${BASE}/palettisation`); await p.waitForSelector('.liste-palettes'); await masquer(p);
  await p.locator(`.carte-palette:has-text("${pal.numero}")`).click();
  await capture(p, '04-palettisation');
  await p.goto(`${BASE}/zone-depart`); await p.waitForTimeout(800); await masquer(p);
  await capture(p, '05-zone-depart');
  await p.goto(`${BASE}/chargement`); await p.waitForTimeout(800); await masquer(p);
  await p.locator(`:text("${ctn.numero}")`).first().click().catch(() => {}); await p.waitForTimeout(900);
  await capture(p, '06-chargement');
  await p.click('button:has-text("Valider le chargement")');
  await capture(p, '07-validation');
  await p.locator('button:has-text("Valider le chargement")').last().click(); await p.waitForTimeout(1200);
  await capture(p, '07b-valide');
  await p.goto(`${BASE}/suivi`); await p.waitForTimeout(1000); await masquer(p);
  await capture(p, '08-suivi');
}

// Campagne clients : base clients, codes promo, envoi d'une offre ; export avec les prix
{
  const p = await session('admin@colis.local');
  await p.goto(`${BASE}/admin`); await p.waitForSelector('.onglets'); await masquer(p);
  await p.click('.onglets button:has-text("Offres")'); await p.waitForSelector('app-offres table'); await masquer(p);
  await capture(p, '09-clients');
  await p.click('.sous-onglets button:has-text("Codes promo")'); await capture(p, '10-codes-promo');
  await p.click('.sous-onglets button:has-text("Envoyer une offre")');
  const cp = p.locator('select[name="cp"]');
  await cp.selectOption(await cp.locator('option', { hasText: 'FIDELITE15' }).getAttribute('value'));
  await p.fill('input[name="sujet"]', '-15 % sur votre prochain envoi');
  await p.fill('textarea[name="msg"]', 'Merci pour votre confiance ! Profitez de 15 % de réduction sur votre prochain envoi de colis vers Abidjan ou Dakar avec le code ci-dessous.\n\nÀ bientôt dans nos dépôts.');
  await capture(p, '11-campagne');
  await p.click('.onglets button:has-text("Export")'); await p.waitForSelector('.liste-export'); await p.waitForTimeout(800);
  await capture(p, '12-export');
}

await navigateur.close();
console.log(`Captures enregistrées dans ${DOSSIER}`);
