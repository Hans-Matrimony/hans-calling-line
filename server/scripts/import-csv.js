// Usage (from server/): node scripts/import-csv.js ../data/leads.csv
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { importCsv } from '../src/lib/import.js';
import { pool } from '../src/db/pool.js';

const file = process.argv[2] ?? '../data/leads.csv';
console.log(JSON.stringify(await importCsv(readFileSync(file)), null, 2));
await pool.end();
