import {el,button} from '../../packages/ui/index.js';

export function categoryOf(book){
 const d=book.data||book;
 if(d.shelf&&!['未分类','藏书','默认书架'].includes(d.shelf))return d.shelf;
 const text=[d.title,d.subtitle].filter(Boolean).join(' ');
 for(const [name,pattern]of [['计算与智能',/计算|机器|学习|算法|编程|程序|智能|神经|数据|computer|learning|programming|algorithm/i],['数学与科学',/数学|物理|化学|生物|几何|代数|概率|科学|math|physics|science/i],['历史与人文',/历史|哲学|社会|政治|文明|经济|心理|history|philosophy/i],['文学与艺术',/文学|小说|诗|散文|艺术|设计|绘画|fiction|poetry|design/i]])if(pattern.test(text))return name;
 return '随手阅读';
}

// A lightweight CSS scene: actual publications are buttons; scenery is aria-hidden.
// Frames run only while a movement key is held, and stop on blur/visibility changes.
export function libraryRoom(publications,{open,onError=()=>{}}){
 const root=el('section',{className:'lib-room',tabIndex:0,'aria-label':'图书馆漫游，W S 走近或退后，A D 左右移动'});
 const world=el('div',{className:'lib-room-world'}),wall=el('div',{className:'lib-room-wall','aria-hidden':true}),floor=el('div',{className:'lib-room-floor','aria-hidden':true});
 const groups=new Map();for(const p of publications){const name=categoryOf(p);if(!groups.has(name))groups.set(name,[]);groups.get(name).push(p);}
 const cases=[];for(const [name,books]of groups)for(let at=0;at<books.length;at+=9)cases.push({name,books:books.slice(at,at+9)});
 const row=el('div',{className:'lib-room-cases'}),hint=el('div',{className:'lib-room-caption','aria-live':'polite'},'走近一排书，开始一段阅读。');
 let opening=false;
 cases.forEach(({name,books},caseIndex)=>{
  const bookcase=el('section',{className:'lib-bookcase','aria-label':name+'书架'},el('header',{},el('span',{},String(caseIndex+1).padStart(2,'0')),el('h3',{},name)));
  for(let level=0;level<3;level++){
   const shelf=el('div',{className:'lib-room-shelf'});
   for(const [i,p]of books.slice(level*3,level*3+3).entries()){
    const b=button('',async()=>{if(opening)return;opening=true;b.classList.add('opening');hint.textContent='正在打开《'+p.data.title+'》…';try{await open(p.id);}catch(e){onError(e);hint.textContent='打开失败，请重试';}finally{opening=false;b.classList.remove('opening');}},'lib-room-book');
    b.setAttribute('aria-label','阅读《'+p.data.title+'》');b.style.setProperty('--binding',['#436358','#8d5947','#697a86','#8a7850','#655b77'][(caseIndex+level+i)%5]);b.style.setProperty('--lean',((i%3)-1)*2+'deg');
    b.append(el('small',{},'材料藏书'),el('strong',{},p.data.title),el('span',{},p.data.author||'私人藏书'),el('i',{'aria-hidden':true}));
    let pointerFocus=false;b.addEventListener('pointerdown',()=>pointerFocus=true);b.addEventListener('pointerup',()=>pointerFocus=false);b.addEventListener('pointercancel',()=>pointerFocus=false);
    const preview=()=>hint.textContent=p.data.title+' · '+(p.data.author||'点击进入阅读');b.addEventListener('mouseenter',preview);b.addEventListener('focus',()=>{preview();if(!pointerFocus){camera.x=caseIndex*350;paint();}});shelf.append(b);
   }
   if(!shelf.children.length)shelf.append(el('span',{className:'lib-shelf-empty'},'留给下一本好书'));
   bookcase.append(shelf);
  }
  row.append(bookcase);
 });
 if(!cases.length)row.append(el('div',{className:'lib-room-empty'},el('h2',{},'书架上的第一束光'),el('p',{},'转换一本材料，加入你的私人图书馆。')));
 const decor=el('div',{className:'lib-room-window','aria-hidden':true},el('i'),el('i'),el('i'),el('i'));
 world.append(wall,floor,decor,row);root.append(world,el('div',{className:'lib-room-vignette','aria-hidden':true}),el('div',{className:'lib-room-sign','aria-hidden':true},'THE QUIET LIBRARY',el('span',{},'让世界慢一页')));
 const camera={x:0,z:0},keys=new Set();let frame=null,last=0,disposed=false;
 function paint(){camera.x=Math.max(0,Math.min(Math.max(0,cases.length-1)*350,camera.x));camera.z=Math.max(0,Math.min(240,camera.z));world.style.setProperty('--walk-x',-camera.x+'px');world.style.setProperty('--walk-z',camera.z+'px');root.dataset.position=Math.round(camera.x)+','+Math.round(camera.z);}
 function step(key,amount){if(key==='a'||key==='ArrowLeft')camera.x-=amount;if(key==='d'||key==='ArrowRight')camera.x+=amount;if(key==='w'||key==='ArrowUp')camera.z+=amount*.45;if(key==='s'||key==='ArrowDown')camera.z-=amount*.45;paint();}
 function tick(time){if(disposed||!keys.size){frame=null;last=0;return;}const dt=Math.min(32,time-last||16);last=time;for(const k of keys)step(k,dt*.4);frame=requestAnimationFrame(tick);}
 function stop(){keys.clear();if(frame!==null)cancelAnimationFrame(frame);frame=null;last=0;}
 root.addEventListener('keydown',e=>{if(e.ctrlKey||e.metaKey||e.altKey)return;const key=e.key.length===1?e.key.toLowerCase():e.key;if(!['w','a','s','d','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key))return;e.preventDefault();if(!keys.has(key)){step(key,20);keys.add(key);}if(frame===null)frame=requestAnimationFrame(tick);});
 root.addEventListener('keyup',e=>{keys.delete(e.key.length===1?e.key.toLowerCase():e.key);if(!keys.size)stop();});root.addEventListener('focusout',stop);root.addEventListener('pointerdown',e=>{if(!e.target.closest('button'))root.focus({preventScroll:true});});
 window.addEventListener('blur',stop);document.addEventListener('visibilitychange',stop);
 const controls=el('div',{className:'lib-room-walk',role:'group','aria-label':'漫游方向'});
 for(const [key,label,glyph]of [['a','向左走','←'],['w','走近书架','↑'],['s','退后','↓'],['d','向右走','→']]){const b=button(glyph,()=>step(key,key==='a'||key==='d'?350:180),'button ghost');b.setAttribute('aria-label',label);controls.append(b);}
 controls.append(button('回到入口',()=>{camera.x=0;camera.z=0;paint();},'button ghost'));
 root.append(el('footer',{className:'lib-room-hud'},el('div',{},hint,el('small',{},'W A S D 漫游 · 点击书籍阅读 · 也可用右侧方向键')),controls));paint();
 return{root,dispose(){disposed=true;stop();window.removeEventListener('blur',stop);document.removeEventListener('visibilitychange',stop);}};
}
