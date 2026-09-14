const fs=require('node:fs'); const assert=require('node:assert/strict');
const path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'src','index.html'),'utf8');
const preload=fs.readFileSync(path.join(root,'preload.js'),'utf8');
const main=fs.readFileSync(path.join(root,'main.js'),'utf8');
const updater=fs.readFileSync(path.join(root,'lib','app-updater.js'),'utf8');
const backend=`${main}\n${updater}`;
const refs=[...new Set([...html.matchAll(/api\.([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)/g)].map(m=>`${m[1]}.${m[2]}`))];
for(const ref of refs){const [scope,key]=ref.split('.'); const m=preload.match(new RegExp(`\\b${scope}\\s*:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`)); assert(m,`preload scope missing: ${scope}`); assert(new RegExp(`\\b${key}\\s*:`).test(m[1]),`preload API missing: ${ref}`);}
for(const ch of [...new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m=>m[1]))]) assert(backend.includes(`'${ch}'`),`main IPC handler/channel missing: ${ch}`);
console.log(`preload contract: OK (${refs.length} renderer APIs, IPC channels checked)`);
