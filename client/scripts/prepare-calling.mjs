import { copyFile, mkdir } from 'node:fs/promises';
const dest=new URL('../public/calling/',import.meta.url);
await mkdir(dest,{recursive:true});
await copyFile(new URL('../node_modules/plivo-browser-sdk/dist/plivobrowsersdk.js',import.meta.url),new URL('plivo.js',dest));
await copyFile(new URL('../node_modules/plivo-browser-sdk/dist/plivobrowsersdk.js.LICENSE.txt',import.meta.url),new URL('plivobrowsersdk.js.LICENSE.txt',dest));
