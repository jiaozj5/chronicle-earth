import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {localizePlace} from './names.js';
import {searchPlaces,projectAtlas} from './service.js';
import {parseTime} from './time.js';
const places=JSON.parse(readFileSync(new URL('./data/places.json',import.meta.url),'utf8'));
test('every shipped map location has a Chinese label and retains original search aliases',()=>{
 assert.equal(places.length,2524);
 for(const p of places){const localized=localizePlace(p);assert.match(localized.data.name,/[\u3400-\u9fff]/,p.id);assert.doesNotMatch(localized.data.name,/[a-z]/i,p.id);assert.equal(localized.data.name,p.data.name);assert.ok(localized.data.aliases.length);}
});
test('old workspace names are localized without rewriting records or custom names',()=>{
 const seed=places.find(p=>p.data.aliases.includes('Liuzhou'));assert.ok(seed);
 const old={...seed,revision:5,data:{...seed.data,name:'Liuzhou'}},before=structuredClone(old);
 const translated=localizePlace(old);assert.equal(translated.data.name,'柳州');assert.equal(translated.revision,5);assert.deepEqual(old,before);
 for(const query of ['柳州','Liuzhou'])assert.equal(searchPlaces([old],query)[0].id,old.id);
 const custom={...old,id:'place_custom'};assert.equal(localizePlace(custom),custom);
 const deleted={...old,deletedAt:'2026-10-02'};assert.equal(searchPlaces([deleted],'柳州').length,0);
});
test('record map projections use Chinese labels for existing seed records',()=>{
 const seed=places.find(p=>p.data.aliases.includes('Liuzhou'));
 const old={...seed,data:{...seed.data,name:'Liuzhou'}};
 const entry={id:'entry_a',objectType:'entry',data:{status:'adopted',occurrenceTime:parseTime('2026'),placeRefs:[{placeId:old.id,confirmed:true}]}};
 const result=projectAtlas([entry],[old]);assert.equal(result.markers.length,1);assert.equal(result.markers[0].name,'柳州');assert.equal(result.markers[0].placeId,old.id);
});
