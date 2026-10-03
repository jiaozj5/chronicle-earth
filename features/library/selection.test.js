import test from 'node:test';
import assert from 'node:assert/strict';
import {regionTarget,svgMark} from './selection.js';
import {resolveTargets,MARKS} from './model.js';

test('Area marks require a drag; point marks create visible, bounded click targets',()=>{
 const bounds={width:800,height:1200},point={x:800,y:1200};
 for(const type of ['highlight','underline','rectangle','circle','triangle'])assert.equal(regionTarget(point,point,bounds,type,0),null);
 for(const type of ['filled-dot','hollow-circle','check','cross','slash']){
  const target=regionTarget(point,point,bounds,type,0);assert.equal(target.rect[2]*bounds.width,24);assert.equal(target.rect[3]*bounds.height,24);assert.doesNotThrow(()=>resolveTargets({pages:[{}]},[target]));
 }
 const line=regionTarget({x:50,y:50},{x:600,y:50},bounds,'underline',0);assert.ok(line.rect[3]*bounds.height>=4);assert.doesNotThrow(()=>resolveTargets({pages:[{}]},[line]));
 const reverse=regionTarget({x:800,y:900},{x:-20,y:-50},bounds,'triangle',0);assert.deepEqual(reverse.rect,[0,0,1,.75]);
});
test('Every mark renders its own geometry; circle/triangle previews are never rectangles',t=>{
 const previous=globalThis.document;globalThis.document={createElementNS:(_,tag)=>({tag,attrs:{},setAttribute(k,v){this.attrs[k]=v;}})};t.after(()=>globalThis.document=previous);
 const shapes={};for(const type of Object.keys(MARKS)){const nodes=[],svg={append:n=>nodes.push(n)};svgMark(svg,{type,color:'#445566'},[{x:20,y:30,width:120,height:40}],{placement:'region',selected:true});shapes[type]=nodes[0];assert.ok(nodes.length);assert.equal(nodes[0].attrs.stroke||nodes[0].attrs.fill,'#445566');}
 assert.equal(shapes.triangle.tag,'path');assert.match(shapes.triangle.attrs.d,/Z$/);assert.equal(shapes.circle.tag,'ellipse');assert.equal(shapes.underline.tag,'path');assert.equal(shapes.highlight.attrs.fill,'#445566');assert.equal(shapes.rectangle.attrs.fill,'none');assert.equal(shapes['filled-dot'].attrs.fill,'#445566');assert.equal(shapes['hollow-circle'].attrs.fill,'none');assert.notEqual(shapes.cross.attrs.d,shapes.check.attrs.d);assert.notEqual(shapes.slash.attrs.d,shapes.check.attrs.d);
 assert.equal(shapes['filled-dot'].attrs.cx,'80');assert.equal(shapes['filled-dot'].attrs.cy,'50');
});
