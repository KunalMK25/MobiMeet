#!/usr/bin/env node
// npm run env:check [-- local|preview|production]   → shows what is set/missing (names only, never values; no network calls).
import { loadDotenv } from '../src/api/dotenv.js';
import { checkEnv, formatReport } from '../src/api/envCheck.js';
const target = ['local', 'preview', 'production'].includes(process.argv[2]) ? process.argv[2] : 'local';
const d = loadDotenv('.env');
console.log(d.loaded ? `Read .env (${d.keys.length} variable(s)).` : 'No .env file found — checking the shell environment only.');
const report = checkEnv(process.env, target);
console.log(formatReport(report));
process.exit(report.ready ? 0 : 1);
