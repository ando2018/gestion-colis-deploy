// Démarrage sans MongoDB installé : replica set en mémoire (transactions actives), données perdues à l'arrêt.
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { creerApp } from './app.js';
import { seed } from './seed.js';

process.env.DEMO ??= '1'; // boutons de connexion rapide sur la page de login
const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
await mongoose.connect(rs.getUri('gestion-colis'));
await mongoose.syncIndexes();
await seed({ demo: true });
const port = Number(process.env.PORT ?? 3000);
creerApp().listen(port, () => console.log(`API (base en mémoire) sur http://localhost:${port}`));
