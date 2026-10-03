import {assert} from '../../packages/contracts/index.js';
export const MAX_READING_BYTES=1024*1024*1024;

// Inspect the central directory before JSZip can hide duplicate names or inflate data.
export function validateReadingZip(buffer){
 let end=-1;for(let at=buffer.length-22;at>=Math.max(0,buffer.length-65557);at--){if(buffer.readUInt32LE(at)===0x06054b50&&at+22+buffer.readUInt16LE(at+20)===buffer.length){end=at;break;}}
 assert(end>=0,'阅读包不是完整 ZIP');const count=buffer.readUInt16LE(end+10),size=buffer.readUInt32LE(end+12),start=buffer.readUInt32LE(end+16);
 assert(buffer.readUInt16LE(end+4)===0&&buffer.readUInt16LE(end+6)===0&&count===buffer.readUInt16LE(end+8)&&count<20000&&start+size===end,'不支持分卷、ZIP64 或过多文件的阅读包');
 let at=start,total=0;const names=new Set();for(let i=0;i<count;i++){
  assert(at+46<=end&&buffer.readUInt32LE(at)===0x02014b50,'阅读包目录损坏');const flags=buffer.readUInt16LE(at+8),method=buffer.readUInt16LE(at+10),length=buffer.readUInt16LE(at+28),extra=buffer.readUInt16LE(at+30),comment=buffer.readUInt16LE(at+32);
  assert(!(flags&1)&&[0,8].includes(method)&&at+46+length+extra+comment<=end,'不支持加密或此压缩算法');const name=buffer.subarray(at+46,at+46+length).toString('utf8');
  assert(name&&!names.has(name)&&!name.includes('\0')&&!/^[/\\]|^[a-z]:/i.test(name)&&!name.split(/[\\/]/).includes('..'),'阅读包路径重复或无效');names.add(name);total+=buffer.readUInt32LE(at+24);assert(total<=MAX_READING_BYTES,'阅读包解压后最多 1 GiB');at+=46+length+extra+comment;
 }
 assert(at===end&&names.has('manifest.json'),'阅读包目录或 manifest 无效');return names;
}
