import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Workspace} from '../../packages/workspace/index.js';
import {createLibraryService} from './service.js';
import {cleanOutline,readPdfOutline} from './outline.js';
import {convertAttachment,fromText,pythonPath} from './conversion.js';

test('Outline boundaries preserve Unicode, hierarchy and physical page indices',()=>{
 const items=cleanOutline([{title:' 第一章 📚 ',pageIndex:0,level:1},{title:'小节',pageIndex:2,level:99},{title:'',pageIndex:0},{title:'bad',pageIndex:3},{title:'negative',pageIndex:-1},{title:'fraction',pageIndex:.5},null],3);
 assert.deepEqual(items.map(h=>[h.title,h.pageIndex,h.level]),[['第一章 📚',0,1],['小节',2,12]]);
 assert.deepEqual(cleanOutline(null,3),[]);
});

test('Native conversion saves PDF bookmarks; legacy books read them without changing book or notes',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'chronicle-outline-')),w=new Workspace(path.join(dir,'workspace')),service=createLibraryService({getWorkspace:()=>w});
 t.after(async()=>{await service.close();w.close();const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(tmpdir())+path.sep));rmSync(resolved,{recursive:true,force:true});});
 const pdf=path.join(dir,'book.pdf');
 execFileSync(pythonPath(),['-c',`from reportlab.pdfgen import canvas
import sys
c=canvas.Canvas(sys.argv[1], pagesize=(200,300))
for i,title in enumerate(["第一章 表征", "1.1 公式与图片"]):
 c.drawString(20,250,"Page "+str(i+1))
 c.bookmarkPage(str(i))
 c.addOutlineEntry(title,str(i),level=i)
 c.showPage()
c.save()`,pdf],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
 const expected=[['第一章 表征',0,1],['1.1 公式与图片',1,2]],triples=items=>items.map(h=>[h.title,h.pageIndex,h.level]);
 assert.deepEqual(triples(await readPdfOutline(pdf,2)),expected);
 const converted=await convertAttachment({path:pdf,name:'book.pdf'},{mode:'native',workspace:w});
 assert.deepEqual(triples(converted.outline),expected);
 const original=w.putAttachment(readFileSync(pdf),{name:'book.pdf',mime:'application/pdf'});
 const doc=fromText('旧版正文。');doc.pages=converted.pages;doc.engine='native';
 const structure=w.putAttachment(Buffer.from(JSON.stringify(doc)),{name:'legacy.json',mime:'application/json'});
 w.commit({requestId:'legacy-fixture',changes:[{id:'publication_legacy',objectType:'publication',expectedRevision:0,data:{title:'旧版藏书',originalName:'book.pdf',originalAttachmentId:original.id,currentRendition:doc.renditionId,renditions:[{id:doc.renditionId,structureAttachmentId:structure.id}]}}]});
 const before=w.get('publication_legacy'),args={publicationId:before.id};
 const legacy=await service.call('book_outline',args);
 assert.deepEqual(triples(legacy.headings),expected);assert.equal(legacy.outlineSource,'pdf-bookmarks');assert.equal(legacy.outlineWarning,null);
 assert.deepEqual((await service.call('book_outline',args)).headings,legacy.headings);
 assert.deepEqual(w.get(before.id),before);assert.equal(w.list({objectType:'annotation'}).total,0);
 // A saved outline is portable and must not depend on a readable original PDF.
 doc.outline=[{title:'保存的目录',pageIndex:1,level:1,source:'pdf-bookmarks'}];
 const saved=w.putAttachment(Buffer.from(JSON.stringify(doc)),{name:'saved.json',mime:'application/json'});
 w.commit({requestId:'saved-fixture',changes:[{id:before.id,objectType:'publication',expectedRevision:before.revision,data:{...before.data,originalAttachmentId:'missing',renditions:[{id:doc.renditionId,structureAttachmentId:saved.id}]}}]});
 assert.deepEqual(triples((await service.call('book_outline',args)).headings),[['保存的目录',1,1]]);
});
