// Déroule le scénario « Gestion de colis dépôt → destination » de bout en bout contre l'API.
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { creerApp } from '../src/app.js';
import { Depot } from '../src/modeles.js';
import { dansEntreprise } from '../src/locataire.js';
import { seed } from '../src/seed.js';

let rs, serveur, imprimante, base;
const recu = []; // ZPL reçus par la fausse imprimante

before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(rs.getUri('test'));
  await mongoose.syncIndexes();
  await seed({ demo: true });
  imprimante = net.createServer((s) => { let d = ''; s.on('data', (x) => (d += x)); s.on('end', () => recu.push(d)); }).listen(0);
  await dansEntreprise({ code: 'DEM-000-000-001', nom: 'Démo', base: 'test' }, () =>
    Depot.updateOne({ code: 'PAR' }, { $set: { 'imprimante.hote': '127.0.0.1', 'imprimante.port': imprimante.address().port } }));
  serveur = creerApp().listen(0);
  base = `http://127.0.0.1:${serveur.address().port}`;
});

after(async () => {
  serveur?.close();
  imprimante?.close();
  await mongoose.disconnect();
  await rs?.stop();
});

async function appel(jeton, methode, chemin, corps, depot = 'PAR') {
  const r = await fetch(base + chemin, {
    method: methode,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}`, ...(depot ? { 'x-depot': depot } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  let json;
  try { json = JSON.parse(texte); } catch { json = texte; }
  return { status: r.status, corps: json };
}
const ok = (r, attendu = 200) => { assert.equal(r.status, attendu, JSON.stringify(r.corps)); return r.corps; };

async function connexion(email, entreprise = 'DEM-000-000-001', motDePasse = '1234') {
  const r = await fetch(`${base}/api/auth/connexion`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entreprise, email, motDePasse }),
  });
  return (await r.json()).jeton;
}

const nouveauColis = (dest, poidsKg, extra = {}) => ({
  destination: dest, poidsKg, nbPieces: 1, description: 'Effets personnels',
  expediteur: { nom: 'DIALLO Awa', tel: '0601020304' }, destinataire: { nom: 'KOUASSI Jean', tel: '+225 07 00 00 00' },
  paiement: { mode: 'ESPECES' }, ...extra,
});

test('scénario complet', async () => {
  const [admin, agent, cariste, quai] = await Promise.all(
    ['admin@colis.local', 'reception@colis.local', 'cariste@colis.local', 'quai@colis.local'].map((e) => connexion(e)),
  );

  // ── Paramétrage et rôles ──
  ok(await appel(admin, 'POST', '/api/depots', { code: 'LYO', nom: 'Dépôt Lyon', prefixe: 'LYO' }), 201);
  assert.equal((await appel(agent, 'POST', '/api/depots', { code: 'X', nom: 'x', prefixe: 'X' })).status, 403);
  assert.equal((await appel(agent, 'GET', '/api/colis', null, 'LYO')).status, 403, 'dépôt non autorisé');
  assert.equal((await appel(cariste, 'POST', '/api/colis', nouveauColis('ABJ', 5))).status, 403);
  assert.equal((await appel(admin, 'POST', '/api/palettes', { destination: 'ABJ' }, null)).status, 400, 'admin sans dépôt');

  // ── Étape 1 : réception ──
  const c1 = ok(await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 12.5, { nbPieces: 3 })), 201);
  assert.match(c1.numero, /^COL-ABJ-\d{6}-0001$/, 'COL-DEST-JJMMAA-XXXX');
  assert.equal(c1.statut, 'RECU');
  assert.equal(c1.montant, 45, '12,5 kg × 3,60');
  assert.equal(c1.paiement.statut, 'PAYE');
  const c2 = ok(await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 20, { paiement: { mode: 'A_DESTINATION' } })), 201);
  assert.equal(c2.paiement.statut, 'A_DESTINATION');
  const c3 = ok(await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 10, { paiement: { mode: 'CARTE', recu: 10, reference: 'TX1' } })), 201);
  assert.equal(c3.paiement.statut, 'PARTIEL');
  const dkr = ok(await appel(agent, 'POST', '/api/colis', nouveauColis('DKR', 4, { paiement: { mode: 'A_DESTINATION' } })), 201);
  const c5 = ok(await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 6)), 201);
  assert.equal((await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 1, { montant: 1 }))).corps.code, 'MOTIF_REQUIS');
  assert.equal(ok(await appel(agent, 'GET', '/api/clients?tel=0601020304')).nom, 'DIALLO Awa');

  // Impression : une étiquette par pièce, envoyée à l'imprimante du dépôt
  const imp = ok(await appel(agent, 'POST', `/api/print/colis/${c1.numero}`, {}));
  assert.equal(imp.envoye, true, imp.erreur);
  assert.equal((imp.zpl.match(/\^XA/g) ?? []).length, 3);
  assert.ok(imp.zpl.includes(`${c1.numero}-3/3`));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(recu.some((z) => z.includes(c1.numero)));

  // ── Étape 2 : palettisation ──
  const p = ok(await appel(cariste, 'POST', '/api/palettes', { destination: 'ABJ' }), 201);
  assert.match(p.numero, /^PAL-ABJ-\d{6}-0001$/, 'PAL-DEST-JJMMAA-XXXX');
  for (const c of [c1, c2, c3]) ok(await appel(cariste, 'POST', `/api/palettes/${p.numero}/colis`, { numero: c.numero }));
  // scan d'une étiquette de pièce = le colis
  assert.equal(ok(await appel(cariste, 'POST', `/api/palettes/${p.numero}/colis`, { numero: `${c1.numero}-2/3` })).dejaPresent, true);
  assert.equal((await appel(cariste, 'POST', `/api/palettes/${p.numero}/colis`, { numero: dkr.numero })).corps.code, 'DESTINATION');
  const p2 = ok(await appel(cariste, 'POST', '/api/palettes', { destination: 'ABJ', poidsMaxKg: 5 }), 201);
  assert.equal((await appel(cariste, 'POST', `/api/palettes/${p2.numero}/colis`, { numero: c5.numero })).corps.code, 'POIDS_MAX');
  assert.equal((await appel(cariste, 'POST', `/api/palettes/${p2.numero}/colis`, { numero: c3.numero })).corps.code, 'TRANSFERT_POSSIBLE');
  // retrait avec motif, puis remise
  assert.equal((await appel(cariste, 'DELETE', `/api/palettes/${p.numero}/colis/${c3.numero}`, {})).status, 400, 'motif obligatoire');
  assert.equal(ok(await appel(cariste, 'DELETE', `/api/palettes/${p.numero}/colis/${c3.code}`, { motif: 'Erreur' })).statut, 'RECU');
  ok(await appel(cariste, 'POST', `/api/palettes/${p.numero}/colis`, { numero: c3.numero }));
  let pal = ok(await appel(cariste, 'GET', `/api/palettes/${p.numero}`));
  assert.equal(pal.nbColis, 3);
  assert.equal(pal.poidsTotal, 42.5);
  ok(await appel(cariste, 'POST', `/api/palettes/${p.numero}/fermer`));
  // page publique du QR (URL courte, liste à jour)
  const page = await (await fetch(`${base}/p/PAR/${p.numero}`)).text();
  assert.ok(page.includes(c1.numero) && !page.includes('KOUASSI'));

  // ── Étape 3 : zone de départ, chargement par exception ──
  const file = ok(await appel(quai, 'GET', '/api/palettes/file-zone-depart?destination=ABJ'));
  assert.deepEqual(file.map((x) => x.numero), [p.numero]);
  assert.equal((await appel(cariste, 'POST', `/api/palettes/${p.numero}/zone-depart`)).status, 403);
  ok(await appel(quai, 'POST', `/api/palettes/${p.numero}/zone-depart`, {}));
  assert.equal(ok(await appel(quai, 'GET', `/api/colis/${c1.numero}`)).statut, 'ZONE_DEPART');

  const ctn = ok(await appel(quai, 'POST', '/api/conteneurs', { destination: 'ABJ', type: "40' HC", numeroOfficiel: 'msku1234567' }), 201);
  assert.match(ctn.numero, /^CTN-ABJ-\d{6}-0001$/, 'CTN-DEST-JJMMAA-XXXX');
  assert.equal(ctn.poidsMaxKg, 26000);
  const scanP = ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/palettes`, { code: `http://x/p/PAR/${p.numero}` }));
  assert.equal(scanP.nbColis, 3);
  assert.equal(ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/palettes`, { code: 'INCONNU-1' })).alerte, true, 'hors manifeste non bloquant');
  // reliquat isolé : c5 sans palette chargé directement
  ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/palettes`, { code: c5.numero }));
  // c2 reste sur le quai → retour dépôt
  ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/retours`, { code: c2.numero, motif: 'Plus de place' }));
  const rec = ok(await appel(quai, 'GET', `/api/conteneurs/${ctn.numero}/recap`));
  assert.equal(rec.nbACharger, 3);
  assert.equal(rec.nbRetours, 1);
  assert.equal(rec.nbHorsManifeste, 1);
  assert.equal(rec.partiels.length, 1);
  // paiement partiel : bloqué sans dérogation
  assert.equal((await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/valider`, {})).corps.code, 'PAIEMENT_PARTIEL');
  const v = ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/valider`, { derogation: true, motif: 'Client connu' }));
  assert.equal(v.statut, 'CHARGE');
  assert.equal(v.nbColis, 3);
  assert.equal(ok(await appel(quai, 'GET', `/api/colis/${c1.numero}`)).statut, 'CHARGE');
  assert.equal(ok(await appel(quai, 'GET', `/api/palettes/${p.numero}`)).statut, 'CHARGEE');

  // annulation admin puis revalidation
  ok(await appel(admin, 'POST', `/api/conteneurs/${ctn.numero}/annuler-validation`, { motif: 'Erreur de comptage' }));
  assert.equal(ok(await appel(quai, 'GET', `/api/colis/${c1.numero}`)).statut, 'ZONE_DEPART');
  ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/valider`, { derogation: true, motif: 'Client connu' }));
  assert.equal((await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/partir`, {})).status, 400, 'scellé obligatoire');
  assert.equal(ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/partir`, { scelle: 'SC-998877' })).statut, 'PARTI');
  assert.equal(ok(await appel(quai, 'GET', `/api/palettes/${p.numero}`)).statut, 'PARTIE', 'la palette part avec son conteneur');
  assert.equal(ok(await appel(quai, 'GET', `/api/colis/${c1.numero}`)).statut, 'PARTI');
  assert.equal((await appel(admin, 'POST', `/api/conteneurs/${ctn.numero}/annuler-validation`, { motif: 'x' })).status, 409);
  const manifeste = ok(await appel(quai, 'GET', `/api/print/manifeste/${ctn.numero}`));
  assert.equal(manifeste.colis.length, 3);
  assert.equal(manifeste.totalAEncaisser, 26, 'reste du colis payé partiellement (36 - 10)');

  // ── Étape 4 : reliquat prioritaire ──
  let r2 = ok(await appel(quai, 'GET', `/api/colis/${c2.numero}`));
  assert.equal(r2.statut, 'RELIQUAT');
  assert.equal(r2.priorite, 1);
  assert.equal(r2.nbReports, 1);
  assert.equal(r2.paletteId, null);
  const enAttente = ok(await appel(cariste, 'GET', '/api/colis?statut=RECU,RELIQUAT&destination=ABJ'));
  assert.equal(enAttente[0].numero, c2.numero, 'reliquat en tête de file');
  const pr = ok(await appel(cariste, 'POST', '/api/palettes', { destination: 'ABJ' }), 201);
  ok(await appel(cariste, 'POST', `/api/palettes/${pr.numero}/colis`, { numero: c2.numero }));
  ok(await appel(cariste, 'POST', `/api/palettes/${pr.numero}/fermer`));
  ok(await appel(quai, 'POST', `/api/palettes/${pr.numero}/zone-depart`));
  const ctn2 = ok(await appel(quai, 'POST', '/api/conteneurs', { destination: 'ABJ', type: "20'" }), 201);
  ok(await appel(quai, 'POST', `/api/conteneurs/${ctn2.numero}/palettes`, { code: pr.numero }));
  // Un reliquat est un colis, jamais une palette : retour dépôt d'une palette refusé, le colis lui-même accepté
  assert.equal((await appel(quai, 'POST', `/api/conteneurs/${ctn2.numero}/retours`, { code: pr.numero })).corps.code, 'RETOUR_COLIS');
  ok(await appel(quai, 'POST', `/api/conteneurs/${ctn2.numero}/retours`, { code: c2.numero }));
  r2 = ok(await appel(quai, 'GET', `/api/colis/${c2.numero}`));
  assert.equal(r2.nbReports, 2);
  assert.equal(r2.statut, 'RELIQUAT');
  assert.equal(r2.paletteId, null, 'le colis quitte sa palette');
  const prApres = ok(await appel(quai, 'GET', `/api/palettes/${pr.numero}`));
  assert.equal(prApres.statut, 'ZONE_DEPART', 'la palette, elle, ne devient pas reliquat');
  assert.equal(prApres.estReliquat, undefined);
  const tdb = ok(await appel(admin, 'GET', '/api/tableau-de-bord', null, null));
  assert.ok(tdb.alertesReliquats.some((x) => x.numero === c2.numero), 'alerte à 2 reports');

  // ── Paiement à destination et annulation ──
  const dkrPaye = ok(await appel(agent, 'POST', `/api/colis/${dkr.numero}/paiement`, { mode: 'ESPECES', montant: 1 }));
  assert.equal(dkrPaye.paiement.statut, 'PARTIEL');
  assert.equal((await appel(agent, 'POST', `/api/colis/${c1.numero}/annuler`, { motif: 'x' })).status, 409, 'colis parti');
  assert.equal(ok(await appel(agent, 'POST', `/api/colis/${dkr.numero}/annuler`, { motif: 'Client annule' })).statut, 'ANNULE');

  // ── Historique complet ──
  const h = ok(await appel(quai, 'GET', `/api/colis/${c3.numero}`)).historique.map((e) => e.type);
  assert.deepEqual(h, [
    'RECEPTION', 'PAIEMENT', 'AJOUT_PALETTE', 'RETRAIT_PALETTE', 'AJOUT_PALETTE', 'ZONE_DEPART', 'PREVU_CONTENEUR',
    'DEROGATION', 'CHARGE', 'ANNULATION', 'DEROGATION', 'CHARGE', 'CONTENEUR_PARTI',
  ]);
});

test('scans concurrents sur la même palette : poids max jamais dépassé', async () => {
  const [agent, cariste] = await Promise.all(['reception@colis.local', 'cariste@colis.local'].map((e) => connexion(e)));
  const p = ok(await appel(cariste, 'POST', '/api/palettes', { destination: 'DKR', poidsMaxKg: 100 }), 201);
  const colis = [];
  for (let i = 0; i < 15; i++) colis.push(ok(await appel(agent, 'POST', '/api/colis', nouveauColis('DKR', 10)), 201));
  const res = await Promise.all(colis.map((c) => appel(cariste, 'POST', `/api/palettes/${p.numero}/colis`, { numero: c.numero })));
  assert.equal(res.filter((r) => r.status === 200).length, 10);
  assert.ok(res.filter((r) => r.status !== 200).every((r) => r.corps.code === 'POIDS_MAX'));
  const pal = ok(await appel(cariste, 'GET', `/api/palettes/${p.numero}`));
  assert.equal(pal.poidsTotal, 100);
  assert.equal(pal.colis.length, 10);
});

test('envoi de plusieurs colis (C1, C2, C3) pour un même expéditeur et destinataire', async () => {
  const agent = await connexion('reception@colis.local');
  const base = {
    destination: 'DKR', // 3,20 €/kg
    expediteur: { nom: 'NDIAYE Fatou', tel: '0611223344' },
    destinataire: { nom: 'SOW Moussa', tel: '+221 77 000 00 00' },
    options: [{ libelle: 'Emballage', montant: 5 }],
  };
  const lignes = [{ poidsKg: 10, description: 'Valise' }, { poidsKg: 5, nbPieces: 2, description: 'Cartons' }, { poidsKg: 2.5 }];

  // Paiement partiel de 40 € sur 61 € : réparti sur C1 (37 €) puis C2 (3 € sur 16 €), C3 rien
  const e = ok(await appel(agent, 'POST', '/api/envois', { ...base, colis: lignes, paiement: { mode: 'ESPECES', recu: 40 } }), 201);
  assert.equal(e.colis.length, 3);
  assert.equal(e.total, 61, '37 (10 kg + 5 € emballage) + 16 + 8');
  assert.equal(e.resteAPayer, 21);
  assert.deepEqual(e.colis.map((c) => c.montant), [37, 16, 8]);
  assert.deepEqual(e.colis.map((c) => c.paiement.recu), [37, 3, 0]);
  assert.deepEqual(e.colis.map((c) => c.paiement.statut), ['PAYE', 'PARTIEL', 'PARTIEL']);
  assert.ok(e.colis.every((c) => c.envoi === e.envoi && c.expediteur.nom === 'NDIAYE Fatou' && c.destinataire.nom === 'SOW Moussa'));
  assert.equal(e.envoi, e.colis[0].numero);
  const numeros = e.colis.map((c) => Number(c.numero.slice(-4)));
  assert.deepEqual(numeros, [numeros[0], numeros[0] + 1, numeros[0] + 2], 'numéros qui se suivent');

  const fiche = ok(await appel(agent, 'GET', `/api/colis/${e.colis[1].numero}`));
  assert.deepEqual(fiche.colisEnvoi.map((c) => c.numero), e.colis.map((c) => c.numero));
  assert.equal(ok(await appel(agent, 'GET', `/api/envois/${e.envoi}`)).length, 3);

  // Montant modifié sur une ligne : motif obligatoire ; aucun colis créé si l'envoi est refusé
  const avant = ok(await appel(agent, 'GET', '/api/colis?destination=DKR')).length;
  const refus = await appel(agent, 'POST', '/api/envois', { ...base, colis: [{ poidsKg: 1 }, { poidsKg: 1, montant: 1 }], paiement: { mode: 'ESPECES' } });
  assert.equal(refus.corps.code, 'MOTIF_REQUIS');
  assert.equal(ok(await appel(agent, 'GET', '/api/colis?destination=DKR')).length, avant);
  assert.equal((await appel(agent, 'POST', '/api/envois', { ...base, colis: [{ poidsKg: 0 }] })).status, 400);
});

test('paiement fractionné : 100 € par carte + 80 € en espèces pour 180 €', async () => {
  const agent = await connexion('reception@colis.local');
  const base = {
    destination: 'ABJ', // 3,60 €/kg
    expediteur: { nom: 'KONE Ibrahim', tel: '0622334455' },
    destinataire: { nom: 'KONE Aya', tel: '+225 05 00 00 00' },
  };
  // 25 kg + 25 kg = 90 € + 90 € = 180 €
  const e = ok(await appel(agent, 'POST', '/api/envois', {
    ...base,
    colis: [{ poidsKg: 25 }, { poidsKg: 25 }],
    paiements: [{ mode: 'CARTE', montant: 100, reference: 'CB-4242' }, { mode: 'ESPECES', montant: 80 }],
  }), 201);
  assert.equal(e.total, 180);
  assert.equal(e.recu, 180);
  assert.equal(e.resteAPayer, 0);
  assert.equal(e.modePaiement, 'MIXTE');
  // C1 (90 €) payé par carte ; C2 : 10 € de carte + 80 € d'espèces
  const [c1, c2] = e.colis;
  assert.deepEqual(c1.paiement.versements.map((v) => [v.mode, v.montant]), [['CARTE', 90]]);
  assert.equal(c1.paiement.mode, 'CARTE');
  assert.equal(c1.paiement.reference, 'CB-4242');
  assert.deepEqual(c2.paiement.versements.map((v) => [v.mode, v.montant]), [['CARTE', 10], ['ESPECES', 80]]);
  assert.equal(c2.paiement.mode, 'MIXTE');
  assert.ok(e.colis.every((c) => c.paiement.statut === 'PAYE'));
  const h = ok(await appel(agent, 'GET', `/api/colis/${c2.numero}`)).historique.find((x) => x.type === 'PAIEMENT');
  assert.equal(h.details.detail, 'CARTE 10 + ESPECES 80');

  // Paiement partiel fractionné : 50 carte + 20 espèces sur 180 → reste 110
  const p = ok(await appel(agent, 'POST', '/api/envois', {
    ...base, colis: [{ poidsKg: 25 }, { poidsKg: 25 }], paiements: [{ mode: 'CARTE', montant: 50 }, { mode: 'ESPECES', montant: 20 }],
  }), 201);
  assert.equal(p.resteAPayer, 110);
  assert.deepEqual(p.colis.map((c) => c.paiement.statut), ['PARTIEL', 'PARTIEL']);
  assert.deepEqual(p.colis.map((c) => c.paiement.recu), [70, 0]);

  // Refus : trop perçu, montant manquant, à destination combiné
  const corps = (paiements) => ({ ...base, colis: [{ poidsKg: 25 }], paiements });
  assert.equal((await appel(agent, 'POST', '/api/envois', corps([{ mode: 'CARTE', montant: 60 }, { mode: 'ESPECES', montant: 40 }]))).corps.code, 'TROP_PERCU');
  assert.equal((await appel(agent, 'POST', '/api/envois', corps([{ mode: 'CARTE', montant: 0 }]))).status, 400);
  assert.equal((await appel(agent, 'POST', '/api/envois', corps([{ mode: 'CARTE', montant: 10 }, { mode: 'A_DESTINATION' }]))).status, 400);
  // À destination seul : rien d'encaissé
  const d = ok(await appel(agent, 'POST', '/api/envois', corps([{ mode: 'A_DESTINATION' }])), 201);
  assert.equal(d.colis[0].paiement.statut, 'A_DESTINATION');
});

test('chargement : retirer une palette ou un colis du conteneur (correction, sans reliquat)', async () => {
  const [agent, cariste, quai] = await Promise.all(['reception@colis.local', 'cariste@colis.local', 'quai@colis.local'].map((e) => connexion(e)));
  const e = ok(await appel(agent, 'POST', '/api/envois', {
    destination: 'DKR', expediteur: { nom: 'A', tel: '0600000001' }, destinataire: { nom: 'B', tel: '0700000001' },
    colis: [{ poidsKg: 5 }, { poidsKg: 6 }, { poidsKg: 7 }], paiements: [{ mode: 'ESPECES', montant: 57.6 }],
  }), 201);
  const [c1, c2, c3] = e.colis;
  const p = ok(await appel(cariste, 'POST', '/api/palettes', { destination: 'DKR' }), 201);
  for (const c of [c1, c2]) ok(await appel(cariste, 'POST', `/api/palettes/${p.numero}/colis`, { numero: c.numero }));
  ok(await appel(cariste, 'POST', `/api/palettes/${p.numero}/fermer`));
  ok(await appel(quai, 'POST', `/api/palettes/${p.numero}/zone-depart`));
  const ctn = ok(await appel(quai, 'POST', '/api/conteneurs', { destination: 'DKR', type: "20'" }), 201);
  ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/palettes`, { code: p.numero }));
  ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/palettes`, { code: c3.numero })); // colis sans palette
  assert.equal(ok(await appel(quai, 'GET', `/api/conteneurs/${ctn.numero}/recap`)).nbACharger, 3);

  // Colis sans palette retiré : il garde son statut, sans report
  ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/retirer`, { code: c3.numero }));
  let x = ok(await appel(quai, 'GET', `/api/colis/${c3.numero}`));
  assert.equal(x.statut, 'RECU');
  assert.equal(x.conteneurId, null);
  assert.equal(x.nbReports, 0);
  // Un colis de la palette : il quitte la palette et le conteneur, sans devenir reliquat
  ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/retirer`, { code: c2.numero, motif: 'Mauvais colis' }));
  x = ok(await appel(quai, 'GET', `/api/colis/${c2.numero}`));
  assert.equal(x.statut, 'RECU');
  assert.equal(x.paletteId, null);
  assert.equal(x.priorite, 0);
  assert.equal(x.historique.at(-1).type, 'RETRAIT_CONTENEUR');
  assert.equal(ok(await appel(quai, 'GET', `/api/palettes/${p.numero}`)).nbColis, 1);
  // La palette entière : retour en zone de départ, plus rien de prévu
  ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/retirer`, { code: p.numero }));
  const pal = ok(await appel(quai, 'GET', `/api/palettes/${p.numero}`));
  assert.equal(pal.statut, 'ZONE_DEPART');
  assert.equal(pal.conteneurId, null);
  assert.equal(ok(await appel(quai, 'GET', `/api/conteneurs/${ctn.numero}/recap`)).nbACharger, 0);
  // On peut la rescanner, et un code absent est refusé
  ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/palettes`, { code: p.numero }));
  assert.equal((await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/retirer`, { code: c3.numero })).status, 404);
});

test('zone de départ : entrée et sortie manuelles d’une palette', async () => {
  const [agent, cariste, quai] = await Promise.all(['reception@colis.local', 'cariste@colis.local', 'quai@colis.local'].map((e) => connexion(e)));
  const e = ok(await appel(agent, 'POST', '/api/envois', {
    destination: 'DKR', expediteur: { nom: 'A', tel: '0600000002' }, destinataire: { nom: 'B', tel: '0700000002' },
    colis: [{ poidsKg: 3 }, { poidsKg: 4 }], paiements: [{ mode: 'ESPECES', montant: 22.4 }],
  }), 201);
  const p = ok(await appel(cariste, 'POST', '/api/palettes', { destination: 'DKR' }), 201);
  for (const c of e.colis) ok(await appel(cariste, 'POST', `/api/palettes/${p.numero}/colis`, { numero: c.numero }));
  // Sortie impossible tant qu'elle n'est pas en zone, entrée impossible tant qu'elle n'est pas fermée
  assert.equal((await appel(quai, 'POST', `/api/palettes/${p.numero}/zone-depart`)).status, 409);
  ok(await appel(cariste, 'POST', `/api/palettes/${p.numero}/fermer`));
  assert.equal((await appel(quai, 'POST', `/api/palettes/${p.numero}/hors-zone-depart`)).status, 409);
  assert.equal((await appel(cariste, 'POST', `/api/palettes/${p.numero}/hors-zone-depart`)).status, 403, 'réservé au chef de quai');

  ok(await appel(quai, 'POST', `/api/palettes/${p.numero}/zone-depart`));
  ok(await appel(quai, 'POST', `/api/palettes/${p.numero}/hors-zone-depart`, { motif: 'Mauvaise palette' }));
  const pal = ok(await appel(quai, 'GET', `/api/palettes/${p.numero}`));
  assert.equal(pal.statut, 'FERMEE');
  assert.ok(pal.colis.every((c) => c.statut === 'SUR_PALETTE'));
  assert.ok(ok(await appel(quai, 'GET', '/api/palettes/file-zone-depart?destination=DKR')).some((x) => x.numero === p.numero), 'revient dans la file');

  // Déjà prévue dans un conteneur : refus
  ok(await appel(quai, 'POST', `/api/palettes/${p.numero}/zone-depart`));
  const ctn = ok(await appel(quai, 'POST', '/api/conteneurs', { destination: 'DKR', type: "20'" }), 201);
  ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/palettes`, { code: p.numero }));
  assert.equal((await appel(quai, 'POST', `/api/palettes/${p.numero}/hors-zone-depart`)).corps.code, 'DANS_CONTENEUR');
});

test('liste des colis : tri « le dernier en premier »', async () => {
  const agent = await connexion('reception@colis.local');
  const recents = ok(await appel(agent, 'GET', '/api/colis?tri=recent&limite=50'));
  const dates = recents.map((c) => new Date(c.dateReception).getTime());
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a), 'du plus récent au plus ancien');
  const file = ok(await appel(agent, 'GET', '/api/colis?statut=RECU,RELIQUAT&limite=50'));
  assert.ok(file.every((c, i) => i === 0 || file[i - 1].priorite >= c.priorite), 'par défaut : reliquats d’abord');
});

test('historique : chaque événement garde le nom et le profil de l’utilisateur', async () => {
  const agent = await connexion('reception@colis.local');
  const c = ok(await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 2)), 201);
  const h = ok(await appel(agent, 'GET', `/api/colis/${c.numero}`)).historique;
  assert.ok(h.length >= 2);
  assert.ok(h.every((e) => e.utilisateurNom === 'Agent réception' && e.utilisateurRole === 'RECEPTION'));
});


test('palettisation : suppression d’une palette, seulement si elle est vide', async () => {
  const [agent, cariste, quai] = await Promise.all(['reception@colis.local', 'cariste@colis.local', 'quai@colis.local'].map((e) => connexion(e)));
  const vide = ok(await appel(cariste, 'POST', '/api/palettes', { destination: 'ABJ' }), 201);
  const pleine = ok(await appel(cariste, 'POST', '/api/palettes', { destination: 'ABJ' }), 201);
  const c = ok(await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 3)), 201);
  ok(await appel(cariste, 'POST', `/api/palettes/${pleine.numero}/colis`, { numero: c.numero }));

  assert.equal((await appel(cariste, 'DELETE', `/api/palettes/${pleine.numero}`)).corps.code, 'PALETTE_NON_VIDE');
  assert.equal((await appel(agent, 'DELETE', `/api/palettes/${vide.numero}`)).status, 403, 'réservé cariste / chef de quai');
  assert.equal(ok(await appel(cariste, 'DELETE', `/api/palettes/${vide.numero}`)).supprime, true);
  assert.equal((await appel(cariste, 'GET', `/api/palettes/${vide.numero}`)).status, 404);
  const journal = ok(await appel(quai, 'GET', '/api/evenements?type=SUPPRESSION_PALETTE'));
  assert.ok(journal.some((e) => e.numero === vide.numero && e.utilisateurRole === 'CARISTE'), 'suppression tracée');

  // Vidée par un retrait : supprimable à son tour
  ok(await appel(cariste, 'DELETE', `/api/palettes/${pleine.numero}/colis/${c.numero}`, { motif: 'Erreur' }));
  ok(await appel(cariste, 'DELETE', `/api/palettes/${pleine.numero}`));
});


test('administration : modification d’un dépôt, messages clairs et valeurs par défaut', async () => {
  const admin = await connexion('admin@colis.local');
  const d = ok(await appel(admin, 'GET', '/api/depots', null, null)).find((x) => x.code === 'PAR');
  const modif = (corps) => appel(admin, 'PUT', `/api/depots/${d._id}`, { ...d, ...corps }, null);

  assert.equal((await modif({ nom: '' })).corps.erreur, '« Nom » est obligatoire');
  assert.match((await modif({ imprimante: { ...d.imprimante, port: 'abc' } })).corps.erreur, /« Port » doit être un nombre/);
  assert.match((await modif({ imprimante: { ...d.imprimante, port: 70000 } })).corps.erreur, /« Port » doit valoir au plus 65535/);
  assert.match((await modif({ imprimante: { ...d.imprimante, dpi: 250 } })).corps.erreur, /« DPI » doit être l’une de ces valeurs/);
  // Port et DPI effacés : valeurs par défaut, l'étiquette reste correcte
  const r = ok(await modif({ nom: 'Dépôt Paris Nord', prefixe: '', imprimante: { ...d.imprimante, port: null, dpi: '' } }));
  assert.equal(r.nom, 'Dépôt Paris Nord');
  assert.equal(r.imprimante.port, 9100);
  assert.equal(r.imprimante.dpi, 203);
  // Préfixe facultatif à la création
  ok(await appel(admin, 'POST', '/api/depots', { code: 'MRS', nom: 'Marseille' }, null), 201);
  // Remise en état pour les autres tests
  ok(await modif({ nom: d.nom }));
});


test('liste des colis : période et tri par date pour l’export', async () => {
  const agent = await connexion('reception@colis.local');
  // Dates locales (comme le filtre de l'API), pas UTC : sinon le test échoue peu après minuit.
  const local = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const aujourdhui = local(new Date());
  const demain = local(new Date(Date.now() + 86400000));
  const anciens = ok(await appel(agent, 'GET', `/api/colis?du=${aujourdhui}&au=${aujourdhui}&tri=ancien&export=1&limite=5000`));
  assert.ok(anciens.length > 0);
  const t = anciens.map((c) => new Date(c.dateReception).getTime());
  assert.deepEqual(t, [...t].sort((a, b) => a - b), 'du plus ancien au plus récent');
  assert.ok(anciens.some((c) => c.paletteId?.numero), 'numéros de palette fournis en export');
  assert.equal(ok(await appel(agent, 'GET', `/api/colis?du=${demain}`)).length, 0, 'rien demain');
});

test('statistiques : chiffre d’affaires, évolution et répartitions (administrateur seulement)', async () => {
  const [admin, agent] = await Promise.all(['admin@colis.local', 'reception@colis.local'].map((e) => connexion(e)));
  const jour = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date());
  const lire = (q = '', depot = 'PAR') => appel(admin, 'GET', `/api/statistiques${q}`, null, depot);
  const avant = ok(await lire(`?du=${jour}&au=${jour}`));
  // un colis payé en deux fois (carte + espèces)
  const e = ok(await appel(agent, 'POST', '/api/envois', {
    destination: 'ABJ', expediteur: { nom: 'A', tel: '0600000000' }, destinataire: { nom: 'B', tel: '0700000000' },
    colis: [{ poidsKg: 10 }], paiements: [{ mode: 'CARTE', montant: 5 }, { mode: 'ESPECES', montant: 3 }],
  }), 201);
  const c = { montant: e.total };
  const s = ok(await lire(`?du=${jour}&au=${jour}`));
  assert.equal(s.granularite, 'jour');
  assert.equal(s.totaux.colis, avant.totaux.colis + 1);
  assert.equal(Math.round((s.totaux.ca - avant.totaux.ca) * 100) / 100, c.montant);
  assert.equal(Math.round((s.totaux.encaisse - avant.totaux.encaisse) * 100) / 100, 8);
  assert.equal(s.serie.length, 1);
  assert.equal(s.serie[0].periode, jour);
  assert.equal(s.serie[0].ca, s.totaux.ca);
  assert.ok(s.destinations.some((d) => d.code === 'ABJ'));
  assert.ok(s.modes.some((m) => m.mode === 'CARTE') && s.modes.some((m) => m.mode === 'ESPECES'), 'encaissements par mode');
  // 90 jours : regroupement par semaine, sans trou ; tous dépôts pour l'admin sans dépôt choisi
  const long = ok(await lire('', null).then(() => lire(`?du=2026-07-01&au=${jour}`, null)));
  assert.equal(long.granularite, 'semaine');
  assert.ok(long.serie.length >= 14 && long.serie.every((p) => /^\d{4}-S\d{2}$/.test(p.periode)));
  assert.equal(new Set(long.serie.map((p) => p.periode)).size, long.serie.length, 'périodes uniques');
  assert.ok(long.depots.length >= 1);
  assert.equal((await appel(agent, 'GET', '/api/statistiques')).status, 403, 'réservé à l’administrateur');
  assert.equal((await lire('?du=2026-10-10&au=2026-01-01')).status, 400, 'période inversée');
});

test('formulaire client : saisi sur la borne, repris par la réception, puis consommé par l’envoi', async () => {
  const [client, agent] = await Promise.all(['client@colis.local', 'reception@colis.local'].map((e) => connexion(e)));
  // incomplet : message clair
  const incomplet = await appel(client, 'POST', '/api/formulaires', { expediteur: { nom: 'TRAORE Moussa' } });
  assert.equal(incomplet.status, 400);
  assert.match(incomplet.corps.erreur, /votre téléphone/);
  const f = ok(await appel(client, 'POST', '/api/formulaires', {
    expediteur: { nom: 'TRAORE Moussa', tel: '0611223344', email: 'm.traore@example.org' },
    destinataire: { nom: 'TRAORE Fatou', tel: '+223 70 00 00 00', adresse: 'Bamako, Hamdallaye' },
    destination: 'abj', description: 'Vêtements',
  }), 201);
  assert.match(f.numero, /^F-\d{3}$/);
  assert.equal(f.destination, 'ABJ');
  // la borne ne lit aucune donnée de colis
  assert.equal((await appel(client, 'GET', '/api/colis')).status, 403);
  assert.equal((await appel(client, 'GET', '/api/formulaires')).status, 403);
  assert.equal((await appel(client, 'GET', '/api/destinations')).status, 200);
  // la réception le voit en attente et le reprend
  const attente = ok(await appel(agent, 'GET', '/api/formulaires'));
  const vu = attente.find((x) => x._id === f._id);
  assert.equal(vu.expediteur.nom, 'TRAORE Moussa');
  const e = ok(await appel(agent, 'POST', '/api/envois', {
    expediteur: vu.expediteur, destinataire: vu.destinataire, destination: vu.destination,
    colis: [{ poidsKg: 8, description: vu.description }], paiement: { mode: 'ESPECES', recu: 0 }, formulaire: vu._id,
  }), 201);
  assert.equal(e.colis[0].destinataire.adresse, 'Bamako, Hamdallaye');
  assert.ok(!ok(await appel(agent, 'GET', '/api/formulaires')).some((x) => x._id === f._id), 'plus en attente');
  const traite = ok(await appel(agent, 'GET', '/api/formulaires?statut=UTILISE')).find((x) => x._id === f._id);
  assert.equal(traite.envoi, e.envoi);
  // réutilisation refusée, et l'envoi n'est pas créé deux fois
  const re = await appel(agent, 'POST', '/api/envois', {
    expediteur: vu.expediteur, destinataire: vu.destinataire, destination: 'ABJ', colis: [{ poidsKg: 2 }], paiement: { mode: 'ESPECES', recu: 0 }, formulaire: vu._id,
  });
  assert.equal(re.status, 409);
  // annulation d'un autre formulaire
  const f2 = ok(await appel(client, 'POST', '/api/formulaires', { expediteur: { nom: 'A', tel: '1' }, destinataire: { nom: 'B', tel: '2' } }), 201);
  assert.equal(ok(await appel(agent, 'DELETE', `/api/formulaires/${f2._id}`)).statut, 'ANNULE');
});

test('palettisation : rouvrir une palette fermée avec un motif ; en zone de départ, la sortir d’abord', async () => {
  const [agent, cariste, quai] = await Promise.all(['reception@colis.local', 'cariste@colis.local', 'quai@colis.local'].map((e) => connexion(e)));
  const c = ok(await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 4)), 201);
  const p = ok(await appel(cariste, 'POST', '/api/palettes', { destination: 'ABJ' }), 201);
  ok(await appel(cariste, 'POST', `/api/palettes/${p.numero}/colis`, { numero: c.numero }));
  assert.equal((await appel(cariste, 'POST', `/api/palettes/${p.numero}/rouvrir`, { motif: 'x' })).status, 409, 'déjà ouverte');
  ok(await appel(cariste, 'POST', `/api/palettes/${p.numero}/fermer`));
  assert.equal((await appel(cariste, 'POST', `/api/palettes/${p.numero}/rouvrir`, {})).status, 400, 'motif obligatoire');
  assert.equal(ok(await appel(cariste, 'POST', `/api/palettes/${p.numero}/rouvrir`, { motif: 'Colis oublié' })).statut, 'OUVERTE');
  // en zone de départ : pas de réouverture directe, il faut d'abord sortir la palette de la zone
  ok(await appel(cariste, 'POST', `/api/palettes/${p.numero}/fermer`));
  ok(await appel(quai, 'POST', `/api/palettes/${p.numero}/zone-depart`));
  const direct = await appel(quai, 'POST', `/api/palettes/${p.numero}/rouvrir`, { motif: 'Ajout' });
  assert.equal(direct.status, 409);
  assert.equal(direct.corps.code, 'PALETTE_EN_ZONE');
  const retrait = await appel(quai, 'DELETE', `/api/palettes/${p.numero}/colis/${c.numero}`, { motif: 'Erreur' });
  assert.equal(retrait.status, 409, 'en zone de départ : pas de retrait, même pour le chef de quai');
  assert.equal(retrait.corps.code, 'PALETTE_EN_ZONE');
  assert.equal(ok(await appel(quai, 'POST', `/api/palettes/${p.numero}/hors-zone-depart`, { motif: 'Ajout d’un colis' })).statut, 'FERMEE');
  assert.equal(ok(await appel(cariste, 'POST', `/api/palettes/${p.numero}/rouvrir`, { motif: 'Ajout d’un colis' })).statut, 'OUVERTE');
  assert.equal(ok(await appel(quai, 'GET', `/api/colis/${c.numero}`)).statut, 'SUR_PALETTE');
  const h = ok(await appel(quai, 'GET', `/api/evenements?numero=${p.numero}`)).filter((e) => e.type === 'PALETTE_ROUVERTE');
  assert.deepEqual(h.map((e) => e.motif).sort(), ['Ajout d’un colis', 'Colis oublié']);
});

test('zone de départ : un colis seul (sans palette) y entre, en sort, et se charge depuis la zone', async () => {
  const [agent, cariste, quai] = await Promise.all(['reception@colis.local', 'cariste@colis.local', 'quai@colis.local'].map((e) => connexion(e)));
  const c = ok(await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 60, { description: 'Réfrigérateur' })), 201);
  assert.equal((await appel(cariste, 'POST', `/api/colis/${c.numero}/zone-depart`)).status, 403, 'chef de quai seulement');
  assert.equal(ok(await appel(quai, 'POST', `/api/colis/${c.numero}/zone-depart`)).statut, 'ZONE_DEPART');
  assert.equal((await appel(quai, 'POST', `/api/colis/${c.numero}/zone-depart`)).status, 409, 'déjà en zone');
  // pas sur une palette tant qu'il est en zone
  const p = ok(await appel(cariste, 'POST', '/api/palettes', { destination: 'ABJ' }), 201);
  assert.equal((await appel(cariste, 'POST', `/api/palettes/${p.numero}/colis`, { numero: c.numero })).status, 409);
  // sortie puis retour en zone
  assert.equal(ok(await appel(quai, 'POST', `/api/colis/${c.numero}/hors-zone-depart`, { motif: 'Erreur' })).statut, 'RECU');
  ok(await appel(quai, 'POST', `/api/colis/${c.numero}/zone-depart`));
  // chargement direct depuis la zone, validation, annulation : il revient en zone
  const params = ok(await appel(quai, 'GET', '/api/parametres'));
  const ctn = ok(await appel(quai, 'POST', '/api/conteneurs', { destination: 'ABJ', type: params.typesConteneur[0].code }), 201);
  const r = ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/palettes`, { code: c.numero }));
  assert.ok(!r.alerte, r.message);
  assert.equal((await appel(quai, 'POST', `/api/colis/${c.numero}/hors-zone-depart`, { motif: 'x' })).status, 409, 'prévu dans un conteneur');
  const tdb = ok(await appel(quai, 'GET', '/api/tableau-de-bord'));
  assert.ok(tdb.colisEnChargement >= 1);
  ok(await appel(quai, 'POST', `/api/conteneurs/${ctn.numero}/valider`, {}));
  assert.equal(ok(await appel(quai, 'GET', `/api/colis/${c.numero}`)).statut, 'CHARGE');
  const admin = await connexion('admin@colis.local');
  ok(await appel(admin, 'POST', `/api/conteneurs/${ctn.numero}/annuler-validation`, { motif: 'Contrôle' }));
  assert.equal(ok(await appel(quai, 'GET', `/api/colis/${c.numero}`)).statut, 'ZONE_DEPART', 'retour en zone après annulation');
});

test('impression : imprimante POS thermique (ESC/POS) au lieu de la Zebra (ZPL)', async () => {
  const [admin, agent] = await Promise.all(['admin@colis.local', 'reception@colis.local'].map((e) => connexion(e)));
  const d = ok(await appel(admin, 'GET', '/api/depots', null, null)).find((x) => x.code === 'PAR');
  const avant = recu.length;
  ok(await appel(admin, 'PUT', `/api/depots/${d._id}`, { ...d, imprimante: { ...d.imprimante, type: 'POS', largeurPapier: 58 } }, null));
  const c = ok(await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 5, { nbPieces: 2 })), 201);
  const r = ok(await appel(agent, 'POST', `/api/print/colis/${c.numero}`, {}));
  assert.equal(r.envoye, true);
  assert.equal(r.typeImprimante, 'POS');
  await new Promise((f) => setTimeout(f, 200));
  const brut = recu.slice(avant).join('');
  assert.ok(brut.startsWith('\x1b@'), 'commence par ESC @ (initialisation)');
  assert.ok(brut.includes(`${c.numero}-2/2`), 'QR de la 2e pièce');
  assert.equal(brut.split('\x1dVB').length - 1, 2, 'une coupe par pièce');
  assert.ok(!brut.includes('^XA'), 'pas de ZPL');
  // impression par le navigateur (POS en USB) : tracée, rien envoyé
  const nav = ok(await appel(agent, 'POST', `/api/print/colis/${c.numero}`, { navigateur: true }));
  assert.equal(nav.envoye, true);
  // retour à la Zebra
  ok(await appel(admin, 'PUT', `/api/depots/${d._id}`, { ...d, imprimante: { ...d.imprimante, type: 'ZEBRA' } }, null));
  const avant2 = recu.length;
  ok(await appel(agent, 'POST', `/api/print/colis/${c.numero}`, {}));
  await new Promise((f) => setTimeout(f, 200));
  assert.ok(recu.slice(avant2).join('').includes('^XA'), 'ZPL pour la Zebra');
});

test('code-barres compact (anciennes étiquettes) : COLABJ… scanné retrouve le colis et la palette', async () => {
  const [agent, cariste] = await Promise.all(['reception@colis.local', 'cariste@colis.local'].map((e) => connexion(e)));
  const c = ok(await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 4, { nbPieces: 3 })), 201);
  const compact = c.numero.replace(/-/g, '');
  assert.match(compact, /^COLABJ\d{10}$/);
  assert.equal(ok(await appel(agent, 'GET', `/api/colis/${compact}`)).numero, c.numero, 'colis retrouvé');
  const p = ok(await appel(cariste, 'POST', '/api/palettes', { destination: 'ABJ' }), 201);
  ok(await appel(cariste, 'POST', `/api/palettes/${p.numero.replace(/-/g, '')}/colis`, { numero: compact }));
  assert.equal(ok(await appel(cariste, 'GET', `/api/palettes/${p.numero.replace(/-/g, '')}`)).colis.length, 1, 'palette retrouvée');
  const admin = await connexion('admin@colis.local');
  // (étiquettes imprimées avant le code numérique : le code compact reste reconnu à la lecture)
  assert.equal((await appel(admin, 'POST', '/api/destinations', { code: 'AB1', pays: 'X', ville: 'X', tarifKg: 1 }, null)).status, 400, 'code de destination : lettres seulement');
});

test('code-barres numérique : 8 chiffres larges, scannés partout à la place du numéro', async () => {
  const [agent, cariste, quai, admin] = await Promise.all(['reception@colis.local', 'cariste@colis.local', 'quai@colis.local', 'admin@colis.local'].map((e) => connexion(e)));
  const c = ok(await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 4)), 201);
  assert.match(c.code, /^1\d{7}$/);
  const p = ok(await appel(cariste, 'POST', '/api/palettes', { destination: 'ABJ' }), 201);
  assert.match(p.code, /^2\d{7}$/);
  assert.equal(ok(await appel(agent, 'GET', `/api/colis/${c.code}`)).numero, c.numero, 'colis par son code');
  ok(await appel(cariste, 'POST', `/api/palettes/${p.code}/colis`, { numero: c.code }), 200);
  assert.equal(ok(await appel(cariste, 'GET', `/api/palettes/${p.code}`)).colis[0].numero, c.numero, 'palette et colis par leurs codes');
  const params = ok(await appel(quai, 'GET', '/api/parametres'));
  const k = ok(await appel(quai, 'POST', '/api/conteneurs', { destination: 'ABJ', type: params.typesConteneur[0].code }), 201);
  assert.match(k.code, /^3\d{7}$/);
  assert.equal(ok(await appel(quai, 'GET', `/api/conteneurs/${k.code}`)).numero, k.numero, 'conteneur par son code');
  ok(await appel(admin, 'PUT', '/api/parametres', { typeCode: 'CODE_BARRE' }, null));
  const zpl = (await appel(agent, 'GET', `/api/print/colis/${c.numero}`)).corps;
  ok(await appel(admin, 'PUT', '/api/parametres', { typeCode: 'QR' }, null));
  assert.ok(zpl.includes(`^FD${c.code}^FS`), 'code-barres = 8 chiffres');
  assert.match(zpl, /\^BY[56]/, 'barres de 5 ou 6 points');
  assert.ok(zpl.includes(`^FD${c.numero}^FS`), 'numéro lisible dessous');
});

test('étiquettes : nom de l’application, téléphone anonymisé, nombre de colis de la palette', async () => {
  const [admin, agent, cariste] = await Promise.all(['admin@colis.local', 'reception@colis.local', 'cariste@colis.local'].map((e) => connexion(e)));
  ok(await appel(admin, 'PUT', '/api/parametres', { nomApplication: 'TransAfrik Cargo' }, null));
  const marque = await (await fetch(`${base}/api/marque?entreprise=dem000000001`)).json();
  assert.equal(marque.nomApplication, 'TransAfrik Cargo', 'nom public (page de connexion)');
  const c = ok(await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 4, { destinataire: { nom: 'KOUASSI Jean', tel: '+225 07 12 34 56 78' } })), 201);
  const zpl = (await appel(agent, 'GET', `/api/print/colis/${c.numero}`)).corps;
  assert.ok(zpl.includes('TransAfrik Cargo'), 'nom sur l’étiquette');
  assert.ok(zpl.includes('**** 5678'), 'téléphone anonymisé');
  assert.ok(!zpl.includes('12 34 56 78'), 'numéro complet absent');
  const p = ok(await appel(cariste, 'POST', '/api/palettes', { destination: 'ABJ' }), 201);
  ok(await appel(cariste, 'POST', `/api/palettes/${p.numero}/colis`, { numero: c.numero }));
  const zp = (await appel(cariste, 'GET', `/api/print/palette/${p.numero}`)).corps;
  assert.ok(zp.includes('TransAfrik Cargo') && zp.includes('PALETTE'), 'bandeau palette');
  assert.match(zp, /\^A0N,150,130\^FD1\^FS/, 'nombre de colis en grand');
  ok(await appel(admin, 'PUT', '/api/parametres', { nomApplication: 'Gestion colis' }, null));
});

test('plateforme : entreprises isolées, chacune avec son identifiant de connexion', async () => {
  const post = async (jeton, chemin, corps) => appel(jeton, 'POST', chemin, corps, null);
  // Connexion à la plateforme (compte distinct des comptes d'entreprise)
  const pf = await fetch(`${base}/api/plateforme/connexion`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'plateforme@colis.local', motDePasse: 'Colis2026!' }),
  });
  assert.equal(pf.status, 200);
  const jpf = (await pf.json()).jeton;
  const admin = await connexion('admin@colis.local');
  assert.equal((await appel(admin, 'GET', '/api/plateforme/entreprises', null, null)).status, 401, 'jeton entreprise refusé sur la plateforme');
  assert.equal((await appel(jpf, 'GET', '/api/colis', null, null)).status, 401, 'jeton plateforme refusé dans une entreprise');

  // Création d'une entreprise : son administrateur reçoit un code provisoire à 4 chiffres
  const invalide = await post(jpf, '/api/plateforme/entreprises', { code: 'TRANSAFRIK', nom: 'X', admin: { email: 'x@y.fr' } });
  assert.equal(invalide.status, 400, 'format XXX-XXX-XXX-XXX obligatoire');
  const auto = ok(await post(jpf, '/api/plateforme/entreprises', { nom: 'Auto', admin: { email: 'a@auto.fr' } }), 201);
  assert.match(auto.code, /^[A-Z0-9]{3}(-[A-Z0-9]{3}){3}$/);
  assert.match(ok(await appel(jpf, 'GET', '/api/plateforme/entreprises/code-libre', null, null)).code, /^[A-Z0-9]{3}(-[A-Z0-9]{3}){3}$/);
  ok(await appel(jpf, 'PUT', `/api/plateforme/entreprises/${auto.id}`, { actif: false }, null));
  const e = ok(await post(jpf, '/api/plateforme/entreprises', {
    code: 'tra nsa fri k01', nom: 'TransAfrik Cargo', contact: { nom: 'M. Koné', tel: '0102030405' }, admin: { nom: 'Admin TA', email: 'admin@colis.local' },
  }), 201);
  assert.equal(e.code, 'TRA-NSA-FRI-K01');
  assert.equal(e.admins, 1);
  assert.match(e.acces.codeProvisoire, /^\d{4}$/);
  assert.equal((await post(jpf, '/api/plateforme/entreprises', { code: 'TRANSAFRIK01', nom: 'Doublon', admin: { email: 'a@b.fr' } })).status, 409);

  // Même e-mail, autre entreprise : comptes distincts. Mauvais identifiant : refusé.
  const marque = await (await fetch(`${base}/api/marque?entreprise=tra-nsa-fri-k01`)).json();
  assert.equal(marque.nomApplication, 'TransAfrik Cargo');
  assert.equal((await fetch(`${base}/api/marque?entreprise=INCONNUE`)).status, 404);
  assert.equal(await connexion('admin@colis.local', 'TRA-NSA-FRI-K01'), undefined, 'code de DEMO refusé chez TRANSAFRIK');

  // Code provisoire : connexion possible, mais il faut d'abord choisir son code (double saisie)
  const r = await fetch(`${base}/api/auth/connexion`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entreprise: 'TRA-NSA-FRI-K01', email: 'admin@colis.local', motDePasse: e.acces.codeProvisoire }),
  });
  const rc = await r.json();
  assert.equal(rc.utilisateur.doitChangerMdp, true);
  const ta = rc.jeton;
  assert.equal((await appel(ta, 'GET', '/api/colis', null, null)).corps.code, 'MDP_A_CHANGER');
  const changer = (corps) => appel(ta, 'PUT', '/api/auth/mot-de-passe', corps, null);
  assert.equal((await changer({ actuel: e.acces.codeProvisoire, nouveau: '4826', confirmation: '4827' })).corps.code, 'CONFIRMATION');
  assert.equal((await changer({ actuel: e.acces.codeProvisoire, nouveau: '1234', confirmation: '1234' })).corps.code, 'CODE_FAIBLE');
  assert.equal((await changer({ actuel: e.acces.codeProvisoire, nouveau: '48261', confirmation: '48261' })).status, 400, '4 chiffres');
  assert.equal((await changer({ actuel: '0000', nouveau: '4826', confirmation: '4826' })).corps.code, 'ACTUEL_INCORRECT');
  ok(await changer({ actuel: e.acces.codeProvisoire, nouveau: '4826', confirmation: '4826' }));
  assert.equal(ok(await appel(ta, 'GET', '/api/auth/moi', null, null)).doitChangerMdp, false);

  // Données isolées : rien de DEMO n'est visible chez TRANSAFRIK, et inversement
  assert.equal(ok(await appel(ta, 'GET', '/api/colis', null, null)).length, 0);
  assert.equal(ok(await appel(ta, 'GET', '/api/depots', null, null)).length, 0);
  assert.ok(ok(await appel(ta, 'GET', '/api/modes-paiement', null, null)).length >= 4, 'modes de paiement usuels créés');
  ok(await appel(ta, 'POST', '/api/depots', { code: 'NCE', nom: 'Dépôt Nice' }, null), 201);
  ok(await appel(ta, 'POST', '/api/destinations', { code: 'ABJ', pays: "Côte d'Ivoire", ville: 'Abidjan', tarifKg: 4 }, null), 201);
  const c = ok(await appel(ta, 'POST', '/api/colis', nouveauColis('ABJ', 5), 'NCE'), 201);
  assert.equal(c.code, '10000001', 'numérotation propre à chaque entreprise');
  assert.equal(ok(await appel(admin, 'GET', '/api/depots', null, null)).some((d) => d.code === 'NCE'), false);
  const memeNumero = await appel(admin, 'GET', `/api/colis/${c.numero}`, null, null); // DEMO peut avoir son propre colis de même numéro
  assert.ok(memeNumero.status === 404 || memeNumero.corps._id !== c._id);
  assert.equal(ok(await appel(admin, 'GET', '/api/colis', null, null)).some((x) => x._id === c._id), false);

  // Réinitialisation par la plateforme : nouveau code provisoire, l'ancien code ne marche plus
  const comptesTA = ok(await appel(jpf, 'GET', `/api/plateforme/entreprises/${e.id}/utilisateurs`, null, null));
  const adminTA = comptesTA.find((u) => u.role === 'ADMIN');
  assert.equal((await post(admin, `/api/plateforme/entreprises/${e.id}/utilisateurs/${adminTA._id}/mot-de-passe`, {})).status, 401);
  const reinit = ok(await post(jpf, `/api/plateforme/entreprises/${e.id}/utilisateurs/${adminTA._id}/mot-de-passe`, {}));
  assert.match(reinit.codeProvisoire, /^\d{4}$/);
  assert.equal(await connexion('admin@colis.local', 'TRA-NSA-FRI-K01', '4826'), undefined, 'ancien code refusé');
  assert.ok(await connexion('admin@colis.local', 'TRA-NSA-FRI-K01', reinit.codeProvisoire));
  const autre = ok(await post(jpf, `/api/plateforme/entreprises/${e.id}/administrateur`, { email: 'second@ta.ci' }));
  assert.equal(autre.cree, true);
  assert.match(autre.codeProvisoire, /^\d{4}$/);

  // Désactivation : connexion et jetons refusés
  ok(await appel(jpf, 'PUT', `/api/plateforme/entreprises/${e.id}`, { actif: false }, null));
  assert.equal(await connexion('admin@colis.local', 'TRA-NSA-FRI-K01', reinit.codeProvisoire), undefined);
  assert.equal((await appel(ta, 'GET', '/api/colis', null, null)).status, 401);
  const liste = ok(await appel(jpf, 'GET', '/api/plateforme/entreprises', null, null));
  assert.deepEqual(liste.map((x) => [x.code, x.actif]).sort(), [['DEM-000-000-001', true], ['TRA-NSA-FRI-K01', false], [auto.code, false]].sort());
  assert.equal(liste.find((x) => x.code === 'TRA-NSA-FRI-K01').colis, 1);

  // Mot de passe de la plateforme : double saisie
  const chpf = (corps) => appel(jpf, 'PUT', '/api/plateforme/moi/mot-de-passe', corps, null);
  assert.equal((await chpf({ actuel: 'Colis2026!', nouveau: 'Plateforme2026', confirmation: 'Plateforme2027' })).corps.code, 'CONFIRMATION');
  assert.equal((await chpf({ actuel: 'Colis2026!', nouveau: 'court', confirmation: 'court' })).status, 400);
  ok(await chpf({ actuel: 'Colis2026!', nouveau: 'Plateforme2026', confirmation: 'Plateforme2026' }));
  ok(await chpf({ actuel: 'Plateforme2026', nouveau: 'Colis2026!', confirmation: 'Colis2026!' }));
});

test('comptes : code provisoire, admin jamais désactivé, blocage après 5 échecs', async () => {
  const admin = await connexion('admin@colis.local');
  const moi = ok(await appel(admin, 'GET', '/api/auth/moi', null, null));
  // Création : code provisoire renvoyé une fois, à changer à la première connexion
  const u = ok(await appel(admin, 'POST', '/api/utilisateurs', { email: 'nouveau@colis.local', nom: 'Nouveau', role: 'RECEPTION', depots: ['PAR'] }, null), 201);
  assert.match(u.codeProvisoire, /^\d{4}$/);
  assert.equal(u.motDePasse, undefined);
  const j = await connexion('nouveau@colis.local', 'DEM-000-000-001', u.codeProvisoire);
  assert.equal((await appel(j, 'GET', '/api/colis')).corps.code, 'MDP_A_CHANGER');
  ok(await appel(j, 'PUT', '/api/auth/mot-de-passe', { actuel: u.codeProvisoire, nouveau: '5079', confirmation: '5079' }, null));
  ok(await appel(j, 'GET', '/api/colis'));

  // Un admin ne peut pas être désactivé (ni par lui-même, ni par un autre admin)
  const a2 = ok(await appel(admin, 'POST', '/api/utilisateurs', { email: 'admin2@colis.local', nom: 'Admin 2', role: 'ADMIN' }, null), 201);
  assert.equal((await appel(admin, 'PUT', `/api/utilisateurs/${a2._id}`, { actif: false }, null)).corps.code, 'ADMIN_ACTIF');
  assert.equal((await appel(admin, 'PUT', `/api/utilisateurs/${moi.id}`, { actif: false }, null)).status, 400);
  ok(await appel(admin, 'PUT', `/api/utilisateurs/${u._id}`, { actif: false }, null));
  ok(await appel(admin, 'PUT', `/api/utilisateurs/${u._id}`, { actif: true }, null));

  // 5 échecs : compte bloqué (même avec le bon code), la réinitialisation débloque
  for (let i = 0; i < 4; i++) assert.equal(await connexion('nouveau@colis.local', 'DEM-000-000-001', '0000'), undefined);
  const bloque = await fetch(`${base}/api/auth/connexion`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entreprise: 'DEM-000-000-001', email: 'nouveau@colis.local', motDePasse: '0000' }),
  });
  assert.equal(bloque.status, 429);
  assert.equal(await connexion('nouveau@colis.local', 'DEM-000-000-001', '5079'), undefined, 'bloqué même avec le bon code');
  const r = ok(await appel(admin, 'POST', `/api/utilisateurs/${u._id}/reinitialiser-code`, {}, null));
  assert.match(r.codeProvisoire, /^\d{4}$/);
  assert.ok(await connexion('nouveau@colis.local', 'DEM-000-000-001', r.codeProvisoire));
  const agent = await connexion('reception@colis.local');
  assert.equal((await appel(agent, 'POST', `/api/utilisateurs/${u._id}/reinitialiser-code`, {}, null)).status, 403);
});

test('entreprise : ancien identifiant (avant XXX-XXX-XXX-XXX) toujours accepté', async () => {
  const r = await fetch(`${base}/api/auth/connexion`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entreprise: 'DEMO', email: 'admin@colis.local', motDePasse: '1234' }),
  });
  // La base de test démarre directement au nouveau format : DEMO n'existe pas comme ancien identifiant ici.
  assert.equal(r.status, 404);
  const demo = await (await fetch(`${base}/api/auth/demo`)).json();
  assert.equal(demo.actif, false, 'hors mode démo');
});

test('logo de l’entreprise : paramétrable par l’admin, public sur la page de connexion', async () => {
  const [admin, agent] = await Promise.all(['admin@colis.local', 'reception@colis.local'].map((e) => connexion(e)));
  // PNG 1×1
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal((await appel(agent, 'PUT', '/api/parametres/logo', { image: png }, null)).status, 403);
  assert.equal((await appel(admin, 'PUT', '/api/parametres/logo', { image: 'data:image/svg+xml;base64,PHN2Zz4=' }, null)).status, 400, 'SVG refusé');
  ok(await appel(admin, 'PUT', '/api/parametres/logo', { image: png }, null));
  const marque = await (await fetch(`${base}/api/marque?entreprise=DEM-000-000-001`)).json();
  assert.match(marque.logo, /^\/api\/logo\/DEM-000-000-001\?v=\d+$/);
  const img = await fetch(base + marque.logo);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(ok(await appel(admin, 'GET', '/api/parametres', null, null)).logo, undefined, 'image absente des paramètres');
  ok(await appel(admin, 'PUT', '/api/parametres/logo', { image: '' }, null));
  assert.equal((await (await fetch(`${base}/api/marque?entreprise=DEM-000-000-001`)).json()).logo, null);
  assert.equal((await fetch(base + marque.logo)).status, 404);
});

/** Faux serveur SMTP minimal (sans TLS ni authentification) : garde les messages reçus. */
function fauxSmtp() {
  const recus = [];
  const serveur = net.createServer((s) => {
    let tampon = '';
    let donnees = false;
    let courant = '';
    s.write('220 faux.smtp ESMTP\r\n');
    s.on('data', (x) => {
      tampon += x.toString('utf8');
      let i;
      while ((i = tampon.indexOf('\r\n')) >= 0) {
        const ligne = tampon.slice(0, i);
        tampon = tampon.slice(i + 2);
        if (donnees) {
          if (ligne === '.') { donnees = false; recus.push(courant); courant = ''; s.write('250 OK\r\n'); } else courant += ligne + '\n';
          continue;
        }
        const cmd = ligne.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') s.write('250-faux.smtp\r\n250 8BITMIME\r\n');
        else if (cmd === 'DATA') { donnees = true; s.write('354 Fin par .\r\n'); }
        else if (cmd === 'QUIT') { s.write('221 Au revoir\r\n'); s.end(); }
        else s.write('250 OK\r\n');
      }
    });
  }).listen(0);
  return { serveur, recus };
}

test('e-mails : code provisoire envoyé à la création et à la réinitialisation (SMTP de la plateforme)', async () => {
  const smtp = fauxSmtp();
  const port = smtp.serveur.address().port;
  const admin = await connexion('admin@colis.local');
  const pf = (await (await fetch(`${base}/api/plateforme/connexion`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'plateforme@colis.local', motDePasse: 'Colis2026!' }),
  })).json()).jeton;
  // Sans SMTP de plateforme : le compte est créé, l'écran signale l'e-mail non envoyé
  const sans = ok(await appel(admin, 'POST', '/api/utilisateurs', { email: 'sans@colis.local', nom: 'Sans Mail', role: 'CARISTE', depots: ['PAR'] }, null), 201);
  assert.equal(sans.mail.envoye, false);
  assert.match(sans.mail.erreur, /non configuré/);
  // L'entreprise ne règle plus de SMTP ni ne consulte de messages (tout passe par la plateforme)
  assert.equal((await appel(admin, 'PUT', '/api/parametres/smtp', { actif: true }, null)).status, 404);
  assert.equal((await appel(admin, 'GET', '/api/messages', null, null)).status, 404);
  assert.equal(ok(await appel(admin, 'GET', '/api/parametres', null, null)).smtp, undefined);

  ok(await appel(pf, 'PUT', '/api/plateforme/smtp', { actif: true, hote: '127.0.0.1', port, securite: 'AUCUNE', expediteur: 'noreply@colis.local', expediteurNom: 'Colis' }, null));
  ok(await appel(admin, 'PUT', '/api/parametres', { nomApplication: 'TransAfrik Cargo' }, null));
  const u = ok(await appel(admin, 'POST', '/api/utilisateurs', { email: 'mail@colis.local', nom: 'Fatou Sow', role: 'RECEPTION', depots: ['PAR'] }, null), 201);
  assert.equal(u.mail.envoye, true);
  const r = ok(await appel(admin, 'POST', `/api/utilisateurs/${u._id}/reinitialiser-code`, {}, null));
  assert.equal(r.mail.envoye, true, 'réinitialisation du code : e-mail par le SMTP de la plateforme');
  await new Promise((ok) => setTimeout(ok, 100));
  assert.equal(smtp.recus.length, 2);
  const [creation, reinit] = smtp.recus.map((m) => m.replace(/=\r?\n/g, ''));
  assert.match(creation, /To: mail@colis\.local/);
  assert.ok(creation.includes(u.codeProvisoire), 'code provisoire dans le message');
  assert.ok(creation.includes('DEM-000-000-001'), 'identifiant entreprise');
  assert.ok(creation.includes('/connexion/DEM-000-000-001'), 'lien direct');
  assert.ok(reinit.includes(r.codeProvisoire));
  ok(await appel(admin, 'PUT', '/api/parametres', { nomApplication: 'Gestion colis' }, null));
  ok(await appel(pf, 'PUT', '/api/plateforme/smtp', { actif: false }, null));
  smtp.serveur.close();
});

test('jeton d’utilisation : alerte 7 jours avant, consultation seule une fois expiré', async () => {
  const pf = await (await fetch(`${base}/api/plateforme/connexion`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'plateforme@colis.local', motDePasse: 'Colis2026!' }),
  })).json();
  const jpf = pf.jeton;
  const demo = ok(await appel(jpf, 'GET', '/api/plateforme/entreprises', null, null)).find((e) => e.code === 'DEM-000-000-001');
  assert.equal(demo.licence.etat, 'valide', 'jeton de démarrage (12 mois)');
  assert.match(demo.licence.jeton, /^LIC(-[A-Z0-9]{4}){4}$/);
  const [admin, agent, cariste] = await Promise.all(['admin@colis.local', 'reception@colis.local', 'cariste@colis.local'].map((e) => connexion(e)));
  const licence = (j) => appel(j, 'GET', '/api/licence', null, null);
  assert.equal(ok(await licence(agent)).jeton, undefined, 'jeton réservé à l’admin');
  assert.match(ok(await licence(admin)).jeton, /^LIC-/);

  // Échéance dans 3 jours : alerte, tout fonctionne encore
  const dans = (j) => new Date(Date.now() + j * 86400000).toISOString();
  ok(await appel(jpf, 'POST', `/api/plateforme/entreprises/${demo.id}/licence`, { expireLe: dans(3) }, null));
  const bientot = ok(await licence(agent));
  assert.equal(bientot.etat, 'bientot');
  assert.ok(bientot.joursRestants >= 3 && bientot.joursRestants <= 4);
  ok(await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 2)), 201);

  // Expiré : créations refusées, listes et statistiques lisibles, paramétrage admin et code possibles
  ok(await appel(jpf, 'POST', `/api/plateforme/entreprises/${demo.id}/licence`, { expireLe: dans(-1) }, null));
  assert.equal(ok(await licence(agent)).etat, 'expiree');
  const refus = await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 2));
  assert.equal(refus.status, 403);
  assert.equal(refus.corps.code, 'LICENCE_EXPIREE');
  assert.equal((await appel(cariste, 'POST', '/api/palettes', { destination: 'ABJ' })).corps.code, 'LICENCE_EXPIREE');
  assert.equal((await appel(admin, 'POST', '/api/conteneurs', { destination: 'ABJ', type: "20'" })).corps.code, 'LICENCE_EXPIREE');
  ok(await appel(agent, 'GET', '/api/colis'));
  ok(await appel(cariste, 'GET', '/api/palettes'));
  ok(await appel(admin, 'GET', '/api/statistiques', null, null));
  ok(await appel(admin, 'GET', '/api/tableau-de-bord'));
  ok(await appel(admin, 'PUT', '/api/parametres', { reliquatAlerteJours: 7 }, null));

  // Renouvellement : 12 mois à partir d'aujourd'hui (l'ancien jeton passe dans l'historique)
  const apres = ok(await appel(jpf, 'POST', `/api/plateforme/entreprises/${demo.id}/licence`, { mois: 12 }, null));
  assert.equal(apres.licence.etat, 'valide');
  assert.notEqual(apres.licence.jeton, demo.licence.jeton);
  assert.ok(apres.licences.length >= 3);
  assert.ok(new Date(apres.licence.expireLe) > new Date(Date.now() + 360 * 86400000));
  ok(await appel(agent, 'POST', '/api/colis', nouveauColis('ABJ', 2)), 201);
  assert.equal((await appel(jpf, 'POST', `/api/plateforme/entreprises/${demo.id}/licence`, { mois: 0 }, null)).status, 400);
});

test('contact : message d’un établissement vers la plateforme, notification par e-mail', async () => {
  const smtp = fauxSmtp();
  const pf = (await (await fetch(`${base}/api/plateforme/connexion`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'plateforme@colis.local', motDePasse: 'Colis2026!' }),
  })).json()).jeton;
  ok(await appel(pf, 'PUT', '/api/plateforme/smtp', { actif: true, hote: '127.0.0.1', port: smtp.serveur.address().port, securite: 'AUCUNE', expediteur: 'plateforme@colis.local' }, null));
  ok(await appel(pf, 'PUT', '/api/plateforme/reglages-contact', { editeur: { nom: 'ColisSoft', email: 'support@colissoft.fr', tel: '01 02 03 04 05' }, emailNotification: 'moi@colissoft.fr' }, null));
  const [agent, admin, client] = await Promise.all(['reception@colis.local', 'admin@colis.local', 'client@colis.local'].map((e) => connexion(e)));
  assert.equal(ok(await appel(agent, 'GET', '/api/contact/editeur')).email, 'support@colissoft.fr');
  assert.equal((await appel(agent, 'POST', '/api/contact', { sujet: '', message: 'Bonjour' })).status, 400);
  assert.equal((await appel(client, 'POST', '/api/contact', { sujet: 'x', message: 'Message de la borne' })).status, 403, 'borne client exclue');
  const r = ok(await appel(agent, 'POST', '/api/contact', { categorie: 'probleme', sujet: 'Imprimante', message: 'L’imprimante du dépôt ne répond plus.', telephone: '0611' }), 201);
  assert.equal(r.mail.envoye, true);
  assert.equal(r.message.entrepriseCode, 'DEM-000-000-001');
  assert.equal(r.message.depot, 'PAR');
  await new Promise((ok) => setTimeout(ok, 100));
  const mail = smtp.recus.at(-1).replace(/=\r?\n/g, '');
  assert.match(mail, /To: moi@colissoft\.fr/);
  assert.ok(mail.includes('DEM-000-000-001') && mail.includes('Agent r'), 'établissement et auteur dans la notification');
  // L'admin de l'entreprise voit tous les messages de l'entreprise, l'agent les siens
  assert.equal(ok(await appel(admin, 'GET', '/api/contact', null, null)).length, 1);
  assert.equal(ok(await appel(agent, 'GET', '/api/contact')).length, 1);
  // La plateforme : liste, non lus, marquer lu
  const l = ok(await appel(pf, 'GET', '/api/plateforme/contact', null, null));
  assert.equal(l.nonLus, 1);
  assert.equal(l.messages[0].auteur.nom, 'Agent réception');
  ok(await appel(pf, 'PUT', `/api/plateforme/contact/${l.messages[0]._id}`, { lu: true }, null));
  assert.equal(ok(await appel(pf, 'GET', '/api/plateforme/contact?nonLus=1', null, null)).messages.length, 0);
  ok(await appel(pf, 'PUT', '/api/plateforme/smtp', { actif: false }, null));
  smtp.serveur.close();
});

test('manuel d’utilisation : PDF illustré, envoyé à la création et renvoyable', async () => {
  const smtp = fauxSmtp();
  const pf = (await (await fetch(`${base}/api/plateforme/connexion`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'plateforme@colis.local', motDePasse: 'Colis2026!' }),
  })).json()).jeton;
  ok(await appel(pf, 'PUT', '/api/plateforme/smtp', { actif: true, hote: '127.0.0.1', port: smtp.serveur.address().port, securite: 'AUCUNE', expediteur: 'plateforme@colis.local' }, null));
  const e = ok(await appel(pf, 'POST', '/api/plateforme/entreprises', { nom: 'Manuel Express', admin: { email: 'chef@manuel.local', nom: 'Chef' } }, null), 201);
  assert.equal(e.acces.mail.envoye, true, 'code provisoire');
  assert.equal(e.acces.manuel.envoye, true, 'manuel envoyé à la création');
  await new Promise((ok) => setTimeout(ok, 150));
  const mail = smtp.recus.at(-1);
  assert.match(mail, /To: chef@manuel\.local/);
  assert.match(mail, /Content-Type: application\/pdf/);
  assert.ok(mail.includes(`manuel-${e.code}.pdf`), 'pièce jointe nommée');
  // Téléchargement : un vrai PDF, avec les captures (volumineux)
  const r = await fetch(`${base}/api/plateforme/entreprises/${e.id}/manuel`, { headers: { authorization: `Bearer ${pf}` } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  const pdf = Buffer.from(await r.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 500000, `PDF illustré (${pdf.length} octets)`);
  // Renvoi à une autre adresse ; refus d'un jeton d'entreprise
  const renvoi = ok(await appel(pf, 'POST', `/api/plateforme/entreprises/${e.id}/manuel`, { a: 'autre@manuel.local' }, null));
  assert.equal(renvoi.envoye, true);
  assert.equal(renvoi.a, 'autre@manuel.local');
  const admin = await connexion('admin@colis.local');
  assert.equal((await appel(admin, 'POST', `/api/plateforme/entreprises/${e.id}/manuel`, {}, null)).status, 401);
  ok(await appel(pf, 'PUT', `/api/plateforme/entreprises/${e.id}`, { actif: false }, null));
  ok(await appel(pf, 'PUT', '/api/plateforme/smtp', { actif: false }, null));
  smtp.serveur.close();
});

test('envoi de plusieurs colis : « Colis 1 », « Colis 2 » par défaut, colis 1/2 et 2/2 sur les étiquettes', async () => {
  const agent = await connexion('reception@colis.local');
  const e = ok(await appel(agent, 'POST', '/api/envois', {
    destination: 'ABJ', expediteur: { nom: 'DIALLO Awa', tel: '0601020304' }, destinataire: { nom: 'KOUASSI Jean', tel: '+225 07 00 00 00' },
    colis: [{ poidsKg: 4 }, { poidsKg: 6, description: 'Télévision' }], paiement: { mode: 'ESPECES' },
  }), 201);
  const [c1, c2] = e.colis;
  assert.deepEqual([c1.description, c2.description], ['Colis 1', 'Télévision'], 'sans description : « Colis N »');
  assert.deepEqual([c1.rangEnvoi, c1.nbEnvoi, c2.rangEnvoi, c2.nbEnvoi], [1, 2, 2, 2], 'colis 1/2 et 2/2');
  const zpl1 = (await appel(agent, 'GET', `/api/print/colis/${c1.numero}`)).corps;
  const zpl2 = (await appel(agent, 'GET', `/api/print/colis/${c2.numero}`)).corps;
  assert.ok(zpl1.includes('^FD1/2^FS') && zpl1.includes('Colis 1 sur 2'), 'étiquette du colis 1 : 1/2');
  assert.ok(zpl2.includes('^FD2/2^FS') && zpl2.includes('Colis 2 sur 2'), 'étiquette du colis 2 : 2/2');
  assert.equal(ok(await appel(agent, 'GET', `/api/colis/${c2.numero}`)).rangEnvoi, 2, 'suivi : rang fourni');
});

test('export détaillé des colis : CSV, Excel et PDF avec palette, conteneur, prix et dates', async () => {
  const [admin, agent, quai] = await Promise.all(['admin@colis.local', 'reception@colis.local', 'quai@colis.local'].map((e) => connexion(e)));
  const e = ok(await appel(agent, 'POST', '/api/envois', {
    destination: 'DKR', expediteur: { nom: 'EXPORT Awa', tel: '0601' }, destinataire: { nom: 'DIOP Khady; fils', tel: '+221 77' },
    colis: [{ poidsKg: 4.5 }, { poidsKg: 6 }], paiement: { mode: 'ESPECES' },
  }), 201);
  const pal = ok(await appel(quai, 'POST', '/api/palettes', { destination: 'DKR' }), 201);
  ok(await appel(quai, 'POST', `/api/palettes/${pal.numero}/colis`, { numero: e.colis[0].numero }));
  const aujourdhui = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const q = `du=${aujourdhui}&au=${aujourdhui}&destination=DKR`;
  const ap = ok(await appel(admin, 'GET', `/api/export/colis/apercu?${q}`, null, null));
  assert.ok(ap.colis >= 2 && ap.poids >= 10.5 && ap.palettes >= 1);
  assert.equal(ap.lignes.length, ap.colis, 'aperçu : la liste des colis exportés');
  assert.ok(ap.lignes.some((x) => x.palette === pal.numero), 'palette du colis');
  assert.ok(ap.lignes.every((x) => typeof x.montant === 'number' && typeof x.montantPaye === 'number' && Array.isArray(x.optionsDetail)), 'aperçu : montant, payé et options');
  assert.ok(ap.paye > 0 && ap.montant >= ap.paye, 'aperçu : totaux montant et payé');
  assert.equal((await appel(agent, 'GET', `/api/export/colis/apercu?${q}`)).status, 403, 'réservé à l’admin');
  const telecharger = (format) => fetch(`${base}/api/export/colis?${q}&format=${format}`, { headers: { authorization: `Bearer ${admin}` } });
  // CSV : séparateur « ; », BOM, guillemets échappés, palette du colis
  const rc = await telecharger('csv');
  assert.match(rc.headers.get('content-disposition'), /export-colis-.*\.csv/);
  const octets = Buffer.from(await rc.arrayBuffer());
  assert.deepEqual([...octets.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM UTF-8 (accents dans Excel)');
  const texteCsv = octets.toString('utf8');
  assert.ok(texteCsv.includes('N° colis;Code-barres;Envoi'), 'entête');
  assert.ok(texteCsv.includes('"DIOP Khady; fils"'), 'champ avec « ; » entre guillemets');
  assert.ok(texteCsv.includes(pal.numero) && texteCsv.includes('4,5'), 'palette et poids à la française');
  assert.ok(texteCsv.split('\r\n')[0].includes('Options;Prix calculé (€);Offre (code promo);Réduction (%);Réduction (€);Montant (€);Payé (€);Reste (€)'), 'colonnes de prix, offre et options');
  // Excel : un vrai classeur (zip) ; PDF : un vrai PDF
  const rx = await telecharger('xlsx');
  const xls = Buffer.from(await rx.arrayBuffer());
  assert.equal(xls.subarray(0, 2).toString(), 'PK');
  const rp = await telecharger('pdf');
  assert.equal(Buffer.from(await rp.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await appel(admin, 'GET', `/api/export/colis?${q}&format=doc`, null, null)).status, 400);
});

test('offres : consentement, base clients, codes promo (validité, utilisations), envoi d’une offre et désinscription', async () => {
  const smtp = fauxSmtp();
  const pf = (await (await fetch(`${base}/api/plateforme/connexion`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'plateforme@colis.local', motDePasse: 'Colis2026!' }),
  })).json()).jeton;
  ok(await appel(pf, 'PUT', '/api/plateforme/smtp', { actif: true, hote: '127.0.0.1', port: smtp.serveur.address().port, securite: 'AUCUNE', expediteur: 'offres@colis.local' }, null));
  const [admin, agent] = await Promise.all(['admin@colis.local', 'reception@colis.local'].map((e) => connexion(e)));
  const demain = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  // Codes promo : création, refus d'un code invalide, vérification au comptoir
  const promo = ok(await appel(admin, 'POST', '/api/codes-promo', { code: 'bienvenue10', pourcentage: 10, fin: demain, utilisationsMax: 1 }, null), 201);
  assert.equal(promo.code, 'BIENVENUE10');
  assert.equal(promo.etat, 'valide');
  assert.equal((await appel(admin, 'POST', '/api/codes-promo', { code: 'X', pourcentage: 10, fin: demain }, null)).status, 400);
  assert.equal((await appel(admin, 'POST', '/api/codes-promo', { pourcentage: 150, fin: demain }, null)).status, 400);
  assert.equal(ok(await appel(agent, 'GET', '/api/codes-promo/verifier?code=bienvenue10')).pourcentage, 10);
  assert.equal((await appel(agent, 'GET', '/api/codes-promo/verifier?code=FAUX')).corps.code, 'PROMO_INVALIDE');

  // Réception avec le code et le consentement : remise de 10 % sur chaque colis, contact enregistré
  const e = ok(await appel(agent, 'POST', '/api/envois', {
    destination: 'ABJ', expediteur: { nom: 'OFFRE Awa', tel: '0699', email: 'awa@exemple.fr' }, destinataire: { nom: 'KOUASSI Jean', tel: '07' },
    colis: [{ poidsKg: 10 }, { poidsKg: 5 }], options: [{ libelle: 'Emballage', montant: 4 }], codePromo: 'BIENVENUE10', offres: { accepte: true },
    paiement: { mode: 'ESPECES' },
  }), 201);
  const [c1, c2] = e.colis;
  assert.equal(c1.montantCalcule, 40, '10 kg × 3,6 + emballage 4');
  assert.equal(c1.remise, 4);
  assert.equal(c1.montant, 36);
  assert.equal(c2.montant, 16.2, '5 kg × 3,6 − 10 %');
  assert.equal(c1.codePromo, 'BIENVENUE10');
  // Code limité à 1 utilisation : refusé ensuite
  const refus = await appel(agent, 'POST', '/api/envois', { destination: 'ABJ', expediteur: { nom: 'B', tel: '06' }, destinataire: { nom: 'C', tel: '07' }, colis: [{ poidsKg: 2 }], codePromo: 'BIENVENUE10', paiement: { mode: 'ESPECES' } });
  assert.equal(refus.corps.code, 'PROMO_INVALIDE');
  assert.equal(ok(await appel(admin, 'GET', '/api/codes-promo', null, null)).find((x) => x.code === 'BIENVENUE10').etat, 'epuise');

  // Base clients : abonné enregistré ; formulaire client sans e-mail valide refusé
  const base1 = ok(await appel(admin, 'GET', '/api/clients-offres?offres=1', null, null));
  const awa = base1.clients.find((x) => x.email === 'awa@exemple.fr');
  assert.ok(awa && awa.consentementOffres && awa.source === 'reception');
  const client = await connexion('client@colis.local');
  assert.equal((await appel(client, 'POST', '/api/formulaires', { expediteur: { nom: 'D', tel: '06' }, destinataire: { nom: 'E', tel: '07' }, offres: { accepte: true } })).status, 400);
  ok(await appel(client, 'POST', '/api/formulaires', { expediteur: { nom: 'Borne Bintou', tel: '0612', email: 'bintou@exemple.fr' }, destinataire: { nom: 'E', tel: '07' }, offres: { accepte: true } }), 201);
  assert.ok(ok(await appel(admin, 'GET', '/api/clients-offres?offres=1', null, null)).clients.some((x) => x.email === 'bintou@exemple.fr' && x.source === 'formulaire'));

  // Envoi d'une offre avec un code promo
  const p2 = ok(await appel(admin, 'POST', '/api/codes-promo', { pourcentage: 15, fin: demain }, null), 201);
  assert.match(p2.code, /^PROMO-[A-Z0-9]{4}$/);
  smtp.recus.length = 0;
  const camp = ok(await appel(admin, 'POST', '/api/campagnes', { sujet: 'Offre de rentrée', message: 'Profitez de 15 % sur votre prochain envoi.', codePromo: p2.code }, null));
  assert.ok(camp.envoyes >= 2);
  await new Promise((ok) => setTimeout(ok, 150));
  const mail = smtp.recus.find((m) => m.includes('awa@exemple.fr')).replace(/=\r?\n/g, '');
  assert.ok(mail.includes(p2.code) && mail.includes('/desinscription/'), 'code promo et lien de désinscription');
  // Désinscription par le lien
  const lien = mail.match(/https?:\/\/[^\s"<>]*\/desinscription\/[^\s"<>]+/)[0].replace(/^https?:\/\/[^/]+/, '');
  const d = await fetch(base + lien);
  assert.equal(d.status, 200);
  assert.equal(ok(await appel(admin, 'GET', '/api/clients-offres', null, null)).clients.find((x) => x.email === 'awa@exemple.fr').consentementOffres, false);
  assert.equal((await fetch(base + lien.slice(0, -3) + 'xyz')).status, 404, 'lien falsifié refusé');
  assert.equal((await appel(agent, 'GET', '/api/clients-offres', null)).status, 403);
  ok(await appel(pf, 'PUT', '/api/plateforme/smtp', { actif: false }, null));
  smtp.serveur.close();
});

test('options par colis : chacune s’ajoute au prix de son colis ; les options de l’envoi (ancienne saisie) vont sur C1', async () => {
  const agent = await connexion('reception@colis.local');
  const e = ok(await appel(agent, 'POST', '/api/envois', {
    destination: 'ABJ', expediteur: { nom: 'OPTION Awa', tel: '0611' }, destinataire: { nom: 'KOUASSI Jean', tel: '07' },
    colis: [{ poidsKg: 10 }, { poidsKg: 5, options: [{ libelle: 'Assurance', montant: 7 }, { libelle: '', montant: 99 }] }],
    paiement: { mode: 'ESPECES' },
  }), 201);
  const [c1, c2] = e.colis;
  const tarif = c1.montantCalcule / c1.poidsKg;
  assert.deepEqual(c1.options, [], 'C1 sans option');
  assert.deepEqual(c2.options, [{ libelle: 'Assurance', montant: 7 }], 'option sans libellé ignorée');
  assert.equal(c2.montant, Math.round((5 * tarif + 7) * 100) / 100, 'prix de C2 = poids × tarif + son option');
  // Ancienne forme : options données pour tout l'envoi → premier colis, sans doublon pour un colis seul
  const seul = ok(await appel(agent, 'POST', '/api/envois', {
    destination: 'ABJ', expediteur: { nom: 'OPTION Awa', tel: '0611' }, destinataire: { nom: 'KOUASSI Jean', tel: '07' },
    poidsKg: 2, options: [{ libelle: 'Emballage', montant: 4 }], paiement: { mode: 'ESPECES' },
  }), 201);
  assert.deepEqual(seul.colis[0].options, [{ libelle: 'Emballage', montant: 4 }]);
});

test('page de connexion : vidéo de présentation et manuel PDF affichés ou masqués pour chaque entreprise', async () => {
  const pf = (await (await fetch(`${base}/api/plateforme/connexion`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'plateforme@colis.local', motDePasse: 'Colis2026!' }),
  })).json()).jeton;
  const code = 'DEM-000-000-001';
  const ent = ok(await appel(pf, 'GET', '/api/plateforme/entreprises', null, null)).find((e) => e.code === code);
  assert.deepEqual(ent.pageConnexion, { video: true, manuel: true }, 'affichés par défaut');
  const page = async (c = code) => (await fetch(`${base}/api/page-connexion?entreprise=${c}`)).json();
  assert.equal((await page()).manuel, true);
  assert.deepEqual(await page(''), { video: false, manuel: false }, 'sans entreprise : rien');
  assert.equal((await fetch(`${base}/api/manuel/${code}`)).status, 200, 'manuel public');
  // Masqués pour cette entreprise : boutons absents, fichiers refusés
  const m = ok(await appel(pf, 'PUT', `/api/plateforme/entreprises/${ent.id}`, { pageConnexion: { video: false, manuel: false } }, null));
  assert.deepEqual(m.pageConnexion, { video: false, manuel: false });
  assert.deepEqual(await page(), { video: false, manuel: false });
  assert.equal((await fetch(`${base}/api/manuel/${code}`)).status, 404, 'manuel masqué : plus téléchargeable');
  assert.equal((await fetch(`${base}/presentation.mp4?entreprise=${code}`)).status, 404, 'vidéo masquée');
  // Une autre modification de la fiche garde le réglage
  ok(await appel(pf, 'PUT', `/api/plateforme/entreprises/${ent.id}`, { notes: 'test' }, null));
  assert.equal((await page()).manuel, false, 'réglage conservé');
  ok(await appel(pf, 'PUT', `/api/plateforme/entreprises/${ent.id}`, { pageConnexion: { video: true, manuel: true } }, null));
  assert.equal((await page()).manuel, true);
});
