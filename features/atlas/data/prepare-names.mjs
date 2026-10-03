// Maintainer-only. Accept the complete Natural Earth populated places GeoJSON.
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export function prepareNames(features,places){
 const byId=new Map(features.map(f=>{const p=f.properties;return['place_ne_'+(p.NE_ID??p.ne_id),p];}));
 const regions=new Intl.DisplayNames(['zh-Hans'],{type:'region'}),names={};
 for(const place of places){
  const p=byId.get(place.id);if(!p)throw new Error('Missing Natural Earth identity: '+place.id);
  const name=p.NAME_ZH??p.name_zh,code=p.ISO_A2??p.iso_a2;
  if(!/[\u3400-\u9fff]/.test(name)||/[a-z]/i.test(name))throw new Error('Missing Chinese name: '+place.id);
  names[place.id]=[name,/^[A-Z]{2}$/.test(code)?regions.of(code):'',p.NAME??p.name];
 }
 return names;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(!process.argv[2])throw new Error('Supply full Natural Earth populated places GeoJSON.');
 const places=JSON.parse(readFileSync(new URL('./places.json',import.meta.url),'utf8'));
 const names=prepareNames(JSON.parse(readFileSync(process.argv[2],'utf8')).features,places);
 writeFileSync(new URL('./place-names-zh.js',import.meta.url),'// Generated from Natural Earth NAME_ZH, keyed by NE_ID. Public domain.\nexport const placeNames='+JSON.stringify(names,null,1)+';\n');
 for(const p of places){const [name,,en]=names[p.id];p.data.name=name;p.data.aliases=[...new Set([...p.data.aliases,en].filter(Boolean))];}
 writeFileSync(new URL('./places.json',import.meta.url),JSON.stringify(places));
 console.log('Prepared '+places.length+' Chinese place names.');
}
