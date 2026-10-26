/* eslint-disable no-console */
import { loadEnv } from '../config/env';
import { migrate, openDatabase } from '../db/database';

const env = loadEnv();
const db = openDatabase(env.databasePath);
const ran = migrate(db);
console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Database schema is up to date.');
console.log(`Database: ${env.databasePath}`);
db.close();
