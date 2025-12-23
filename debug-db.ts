import { Database } from 'bun:sqlite';
import { DB_PATH } from './src/config';

console.log('Checking DB at:', DB_PATH);

try {
  const db = new Database(DB_PATH, { readonly: true });
  const journalMode = db.query('PRAGMA journal_mode;').get();
  console.log('Journal Mode:', journalMode);
  
  const busyTimeout = db.query('PRAGMA busy_timeout;').get();
  console.log('Busy Timeout:', busyTimeout);

  db.close();
} catch (error) {
  console.error('Error opening DB:', error);
}
