import mongoose from 'mongoose';
import { creerApp } from './app.js';
import { seed } from './seed.js';

// Les transactions exigent un replica set, même à un seul nœud (voir docker-compose.yml).
await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/gestion-colis?replicaSet=rs0');
await mongoose.syncIndexes();
await seed();
const port = Number(process.env.PORT ?? 3000);
creerApp().listen(port, () => console.log(`API prête sur http://localhost:${port}`));
