import { cleanupReports } from '../src/storage.js';
console.log(`Borttagna utgångna rapporter: ${await cleanupReports()}`);
