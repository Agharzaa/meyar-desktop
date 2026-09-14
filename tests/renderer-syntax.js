'use strict';
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'..','src','index.html'),'utf8');
const m=html.match(/<script>([\s\S]*?)<\/script>/i);
if(!m) throw new Error('Renderer script not found');
new vm.Script(m[1],{filename:'renderer-inline.js'});
console.log('renderer syntax: OK');
