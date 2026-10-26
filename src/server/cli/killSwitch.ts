/* eslint-disable no-console */
// Operate the persistent kill switch directly on the database (works while the server is down).
// Usage: npm run kill-switch -- status | on "<reason>" | off
import { loadEnv } from '../config/env';
import { migrate, openDatabase } from '../db/database';
import { Store } from '../db/store';

const [cmd, ...rest] = process.argv.slice(2);
const env = loadEnv();
const db = openDatabase(env.databasePath);
migrate(db);
const store = new Store(db);
const actor = `cli:${process.env.USER ?? 'operator'}`;
if (cmd === 'on') {
  const s = store.setKillSwitch(true, rest.join(' ') || 'activated from CLI', actor);
  console.log('Kill switch ACTIVE (persisted):', s);
} else if (cmd === 'off') {
  const s = store.setKillSwitch(false, null, actor);
  console.log('Kill switch cleared:', s);
} else {
  console.log('Kill switch:', store.getKillSwitch());
}
db.close();
