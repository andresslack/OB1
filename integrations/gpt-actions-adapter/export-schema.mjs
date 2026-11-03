import { writeFileSync } from 'node:fs';
import { openapi } from './contracts.mjs';
const url = process.env.ACTION_PUBLIC_URL;
if (!url || !url.startsWith('https://')) throw new Error('Set ACTION_PUBLIC_URL to the deployed adapter HTTPS URL.');
writeFileSync(new URL('./openapi.json', import.meta.url), JSON.stringify(openapi(url), null, 2) + '\n');
