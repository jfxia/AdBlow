import { writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const BASE = 'https://afford.gjvrohros.cc';

const candidates = [
  '/category/jrxw1/ad-sdk-v0.0.4.10.js',
  '/ad-sdk-v0.0.4.10.js',
  '/usr/themes/Mirages/js/7.10.0/ad-sdk-v0.0.4.10.js',
  '/usr/themes/Mirages/ad-sdk-v0.0.4.10.js',
  '/usr/themes/Mirages/js/ad-sdk-v0.0.4.10.js',
  '/category/jrxw1/ad-sdk-v0.0.4.10.js',
  '/usr/themes/Mirages/css/7.10.0/ssp.css?v=8',
];

for (const p of candidates) {
  const url = BASE + p;
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, referer: BASE + '/category/jrxw1/' } });
    const body = await res.text();
    const tag = res.status === 200 ? 'OK ' : 'MISS';
    console.log(`${tag} ${res.status} ${body.length.toString().padStart(7)}  ${p}`);
    if (res.status === 200) {
      const name = p.split('/').pop().split('?')[0];
      writeFileSync(new URL(`./dl-${name}`, import.meta.url), body, 'utf8');
    }
  } catch (e) {
    console.log(`ERR      ---  ${p}  ${e.message}`);
  }
}
