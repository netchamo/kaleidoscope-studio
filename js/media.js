// Media container utilities: MP4 muxer, H.264 helpers, MP4/MOV parsing, AAC passthrough.
/* ---------------- MP4 muxer ---------------- */
const Mux = (()=>{
  const enc=new TextEncoder();
  function cat(arrs){ let n=0; for(const a of arrs) n+=a.length; const o=new Uint8Array(n); let p=0; for(const a of arrs){ o.set(a,p); p+=a.length; } return o; }
  function u8(v){ return new Uint8Array([v&255]); }
  function u16(v){ return new Uint8Array([(v>>8)&255,v&255]); }
  function u24(v){ return new Uint8Array([(v>>16)&255,(v>>8)&255,v&255]); }
  function u32(v){ return new Uint8Array([(v>>>24)&255,(v>>>16)&255,(v>>>8)&255,v&255]); }
  function i32(v){ return u32(v>>>0); }
  function str(s){ return enc.encode(s); }
  function box(type,...parts){ const body=cat(parts.flat()); return cat([u32(body.length+8),str(type),body]); }
  function full(type,ver,flags,...parts){ return box(type,u8(ver),u24(flags),...parts); }
  const MATRIX=[u32(0x10000),u32(0),u32(0),u32(0),u32(0x10000),u32(0),u32(0),u32(0),u32(0x40000000)];
  const zeros=n=>new Uint8Array(n);

  function sttsFrom(durs){ const e=[]; for(const d of durs){ if(e.length&&e[e.length-1][1]===d) e[e.length-1][0]++; else e.push([1,d]); }
    return full('stts',0,0,u32(e.length),...e.map(([c,d])=>[u32(c),u32(d)])); }
  function esds(asc,bitrate){
    const dsi=cat([u8(5),u8(asc.length),asc]);
    const dcd=cat([u8(4),u8(13+dsi.length),u8(0x40),u8(0x15),u24(0),u32(bitrate),u32(bitrate),dsi]);
    const sl=cat([u8(6),u8(1),u8(2)]);
    const es=cat([u8(3),u8(3+dcd.length+sl.length),u16(2),u8(0),dcd,sl]);
    return full('esds',0,0,es);
  }
  function trak(t,movieTs,offsets){
    const isV=t.kind==='video';
    const n=t.samples.length;
    const durMovie=Math.round(t.duration/t.timescale*movieTs);
    const tkhd=full('tkhd',0,3,u32(0),u32(0),u32(t.id),u32(0),u32(durMovie),zeros(8),u16(0),u16(0),u16(isV?0:0x0100),u16(0),MATRIX,u32((isV?t.width:0)<<16>>>0),u32((isV?t.height:0)<<16>>>0));
    let edts=[];
    if(t.shift>0) edts=[box('edts',full('elst',0,0,u32(1),u32(durMovie),u32(t.shift),u16(1),u16(0)))];
    const mdhd=full('mdhd',0,0,u32(0),u32(0),u32(t.timescale),u32(t.duration),u16(0x55c4),u16(0));
    const hdlr=full('hdlr',0,0,u32(0),str(isV?'vide':'soun'),zeros(12),str(isV?'VideoHandler\0':'SoundHandler\0'));
    const mhd=isV?full('vmhd',0,1,zeros(8)):full('smhd',0,0,u16(0),u16(0));
    const dinf=box('dinf',full('dref',0,0,u32(1),full('url ',0,1)));
    let entry;
    if(isV){
      const comp=zeros(32);
      const colr=box('colr',str('nclx'),u16(1),u16(1),u16(1),u8(0));
      entry=box('avc1',zeros(6),u16(1),u16(0),u16(0),zeros(12),u16(t.width),u16(t.height),u32(0x00480000),u32(0x00480000),u32(0),u16(1),comp,u16(0x18),u16(0xffff),box('avcC',t.avcC),colr);
    } else {
      entry=box('mp4a',zeros(6),u16(1),zeros(8),u16(t.channels),u16(16),u16(0),u16(0),u32((t.sampleRate<<16)>>>0),esds(t.asc,t.bitrate));
    }
    const stsd=full('stsd',0,0,u32(1),entry);
    const stts=sttsFrom(t.samples.map(s=>s.dur));
    const parts=[stsd,stts];
    if(isV){
      const keys=[]; t.samples.forEach((s,i)=>{ if(s.key) keys.push(i+1); });
      if(keys.length<n) parts.push(full('stss',0,0,u32(keys.length),...keys.map(k=>u32(k))));
      if(t.samples.some(s=>s.cto!==0)){
        const e=[]; for(const s of t.samples){ if(e.length&&e[e.length-1][1]===s.cto) e[e.length-1][0]++; else e.push([1,s.cto]); }
        parts.push(full('ctts',0,0,u32(e.length),...e.map(([c,o])=>[u32(c),u32(o)])));
      }
    }
    // stsc run-length over chunk sizes
    const sc=[]; t.chunks.forEach((c,i)=>{ if(!sc.length||sc[sc.length-1][1]!==c.count) sc.push([i+1,c.count]); });
    parts.push(full('stsc',0,0,u32(sc.length),...sc.map(([f,c])=>[u32(f),u32(c),u32(1)])));
    parts.push(full('stsz',0,0,u32(0),u32(n),...t.samples.map(s=>u32(s.data.length))));
    parts.push(full('stco',0,0,u32(t.chunks.length),...t.chunks.map(c=>u32(offsets?offsets.get(c):0))));
    const stbl=box('stbl',...parts);
    const minf=box('minf',mhd,dinf,stbl);
    return box('trak',tkhd,...edts,box('mdia',mdhd,hdlr,minf));
  }
  function build(tracks){
    const movieTs=1000;
    // chunk samples (~0.5s) and interleave by start time
    const all=[];
    for(const t of tracks){
      t.chunks=[]; let cur=null; let time=0;
      for(const s of t.samples){
        if(!cur||time-cur.start>=t.timescale*0.5){ cur={start:time,count:0,samples:[],sec:time/t.timescale}; t.chunks.push(cur); all.push(cur); }
        cur.samples.push(s); cur.count++; time+=s.dur;
      }
    }
    all.sort((a,b)=>a.sec-b.sec);
    const durMs=Math.max(...tracks.map(t=>Math.round(t.duration/t.timescale*movieTs)));
    const mk=offsets=>box('moov',full('mvhd',0,0,u32(0),u32(0),u32(movieTs),u32(durMs),u32(0x10000),u16(0x100),zeros(10),MATRIX,zeros(24),u32(tracks.length+1)),...tracks.map(t=>trak(t,movieTs,offsets)));
    const ftyp=box('ftyp',str('isom'),u32(512),str('isom'),str('iso2'),str('avc1'),str('mp41'));
    const moovSize=mk(null).length;
    let pos=ftyp.length+moovSize+8; const offsets=new Map(); let mdatLen=0;
    for(const c of all){ offsets.set(c,pos); for(const s of c.samples){ pos+=s.data.length; mdatLen+=s.data.length; } }
    const moov=mk(offsets);
    const out=[ftyp,moov,u32(mdatLen+8),str('mdat')];
    for(const c of all) for(const s of c.samples) out.push(s.data);
    return new Blob(out,{type:'video/mp4'});
  }
  return {build};
})();

/* ---------------- H.264 helpers ---------------- */
function splitAnnexB(d){
  const nals=[]; let i=0, start=-1;
  while(i+3<=d.length){
    let sc=0; if(d[i]===0&&d[i+1]===0&&d[i+2]===1) sc=3; else if(i+4<=d.length&&d[i]===0&&d[i+1]===0&&d[i+2]===0&&d[i+3]===1) sc=4;
    if(sc){ if(start>=0) nals.push(d.subarray(start,i)); i+=sc; start=i; } else i++;
  }
  if(start>=0) nals.push(d.subarray(start));
  return nals;
}
function isAnnexB(d){ return d.length>4&&d[0]===0&&d[1]===0&&(d[2]===1||(d[2]===0&&d[3]===1)); }
function annexBToAvc(d,state){
  const out=[]; let n=0;
  for(const nal of splitAnnexB(d)){
    const t=nal[0]&31;
    if(t===7){ state.sps=nal.slice(); continue; } if(t===8){ state.pps=nal.slice(); continue; } if(t===9) continue;
    out.push(nal); n+=4+nal.length;
  }
  const o=new Uint8Array(n); let p=0;
  for(const nal of out){ o[p]=nal.length>>>24; o[p+1]=(nal.length>>16)&255; o[p+2]=(nal.length>>8)&255; o[p+3]=nal.length&255; o.set(nal,p+4); p+=4+nal.length; }
  return o;
}
function buildAvcC(sps,pps){
  const o=new Uint8Array(11+sps.length+pps.length);
  o.set([1,sps[1],sps[2],sps[3],0xff,0xe1,sps.length>>8,sps.length&255],0); o.set(sps,8);
  const p=8+sps.length; o.set([1,pps.length>>8,pps.length&255],p); o.set(pps,p+3); return o;
}

/* ---------------- audio passthrough (copy AAC from MP4/MOV) ---------------- */
async function readBytes(file,pos,len){ return new Uint8Array(await file.slice(pos,pos+len).arrayBuffer()); }
function rd32(d,p){ return ((d[p]<<24)>>>0)+(d[p+1]<<16)+(d[p+2]<<8)+d[p+3]; }
function rd64(d,p){ return rd32(d,p)*4294967296+rd32(d,p+4); }
function typ(d,p){ return String.fromCharCode(d[p],d[p+1],d[p+2],d[p+3]); }
function children(d,start,end){
  const out=[]; let p=start;
  while(p+8<=end){ let size=rd32(d,p); const t=typ(d,p+4); let hdr=8;
    if(size===1){ size=rd64(d,p+8); hdr=16; } else if(size===0) size=end-p;
    if(size<hdr||p+size>end) break;
    out.push({type:t,start:p,body:p+hdr,end:p+size}); p+=size; }
  return out;
}
function child(d,b,t){ return children(d,b.body,b.end).find(x=>x.type===t); }
function readDescLen(d,p){ let len=0,i=0,b; do{ b=d[p+i]; len=(len<<7)|(b&127); i++; }while((b&128)&&i<4); return [len,i]; }
function parseEsds(d,start,end){
  let p=start+4; // full box header
  const descs={};
  while(p<end){
    const tag=d[p]; const [len,n]=readDescLen(d,p+1); const body=p+1+n;
    if(tag===3){ let q=body+2; const fl=d[q]; q++; if(fl&128) q+=2; if(fl&64) q+=1+d[q]; if(fl&32) q+=2; p=q; continue; }
    if(tag===4){ descs.obj=d[body]; descs.avg=rd32(d,body+9); p=body+13; continue; }
    if(tag===5){ descs.asc=d.slice(body,body+len); break; }
    p=body+len;
  }
  return descs;
}
async function findMoov(file){
  let pos=0;
  while(pos+8<=file.size){
    const h=await readBytes(file,pos,16); let size=rd32(h,0); const t=typ(h,4); let hdr=8;
    if(size===1){ size=rd64(h,8); hdr=16; } else if(size===0) size=file.size-pos;
    if(size<8) return null;
    if(t==='moov') return await readBytes(file,pos,size);
    pos+=size;
  }
  return null;
}
async function extractAac(file,maxSec){
  const d=await findMoov(file); if(!d) return {err:'לא נמצא מידע מבנה בקובץ'};
  const moov={body:8,end:d.length};
  for(const trak of children(d,moov.body,moov.end).filter(x=>x.type==='trak')){
    const mdia=child(d,trak,'mdia'); if(!mdia) continue;
    const hdlr=child(d,mdia,'hdlr'); if(!hdlr||typ(d,hdlr.body+8)!=='soun') continue;
    const mdhd=child(d,mdia,'mdhd'); const v=d[mdhd.body]; const ts=v===1?rd32(d,mdhd.body+20):rd32(d,mdhd.body+12);
    const stbl=child(d,child(d,mdia,'minf'),'stbl');
    const stsd=child(d,stbl,'stsd'); const entry=children(d,stsd.body+8,stsd.end)[0];
    if(!entry||entry.type!=='mp4a') return {err:'השמע בקובץ אינו בפורמט נתמך להעתקה'};
    const channels=(d[entry.body+16]<<8)|d[entry.body+17];
    let ep=-1; for(let i=entry.body;i<entry.end-4;i++){ if(d[i]===101&&d[i+1]===115&&d[i+2]===100&&d[i+3]===115){ ep=i-4; break; } }
    if(ep<0) return {err:'חסר תיאור קידוד השמע'};
    const es=parseEsds(d,ep+8,ep+rd32(d,ep));
    if(es.obj!==0x40||!es.asc) return {err:'השמע אינו בקידוד הנפוץ'};
    // sample tables
    const stsz=child(d,stbl,'stsz'); const fixed=rd32(d,stsz.body+4), n=rd32(d,stsz.body+8);
    const sizes=new Array(n); for(let i=0;i<n;i++) sizes[i]=fixed||rd32(d,stsz.body+12+i*4);
    let co=child(d,stbl,'stco'), big=false; if(!co){ co=child(d,stbl,'co64'); big=true; }
    const nc=rd32(d,co.body+4); const chunkOff=new Array(nc);
    for(let i=0;i<nc;i++) chunkOff[i]=big?rd64(d,co.body+8+i*8):rd32(d,co.body+8+i*4);
    const stsc=child(d,stbl,'stsc'); const ne=rd32(d,stsc.body+4); const sc=[];
    for(let i=0;i<ne;i++) sc.push([rd32(d,stsc.body+8+i*12),rd32(d,stsc.body+12+i*12)]);
    const stts=child(d,stbl,'stts'); const nt=rd32(d,stts.body+4); const durs=[];
    for(let i=0;i<nt;i++){ const c=rd32(d,stts.body+8+i*8), dl=rd32(d,stts.body+12+i*8); for(let k=0;k<c;k++) durs.push(dl); }
    // audio edit list (encoder priming)
    let shift=0; const edts=child(d,trak,'edts'); if(edts){ const el=child(d,edts,'elst'); if(el){ const ev=d[el.body]; const cnt=rd32(d,el.body+4);
      for(let i=0;i<cnt;i++){ const mt=ev===1?rd64(d,el.body+8+i*20+8):rd32(d,el.body+8+i*12+4); if(mt!==0xffffffff&&mt<1e12){ shift=mt; break; } } } }
    const limit=maxSec*ts+shift;
    const samples=[]; let si=0, time=0;
    for(let c=0;c<nc&&si<n;c++){
      let per=sc[0][1]; for(const [first,cnt] of sc){ if(first<=c+1) per=cnt; else break; }
      let total=0; for(let k=0;k<per&&si+k<n;k++) total+=sizes[si+k];
      const buf=await readBytes(file,chunkOff[c],total); let p=0;
      for(let k=0;k<per&&si<n;k++,si++){ const dur=durs[si]||1024;
        if(time<limit) samples.push({data:buf.subarray(p,p+sizes[si]),dur,key:true,cto:0});
        p+=sizes[si]; time+=dur; }
      if(time>=limit) break;
    }
    if(!samples.length) return {err:'לא נמצאו דגימות שמע'};
    const dur=samples.reduce((a,s)=>a+s.dur,0);
    return {track:{kind:'audio',id:2,timescale:ts,sampleRate:ts,channels:channels||2,bitrate:es.avg||128000,asc:es.asc,samples,duration:dur,shift},how:'copy'};
  }
  return {err:'אין שמע בסרטון',none:true};
}


export async function detectTransfer(f){
  try{
    const d=await findMoov(f); if(!d) return 0;
    for(const trak of children(d,8,d.length).filter(x=>x.type==='trak')){
      const mdia=child(d,trak,'mdia'); if(!mdia) continue; const h=child(d,mdia,'hdlr'); if(!h||typ(d,h.body+8)!=='vide') continue;
      const stsd=child(d,child(d,child(d,mdia,'minf'),'stbl'),'stsd'); const e=children(d,stsd.body+8,stsd.end)[0]; if(!e) continue;
      for(let i=e.body;i<e.end-18;i++) if(typ(d,i)==='colr'&&(typ(d,i+4)==='nclx'||typ(d,i+4)==='nclc')) return (d[i+10]<<8)|d[i+11];
      return 0;
    }
  }catch(e){}
  return 0;
}
export { Mux, splitAnnexB, isAnnexB, annexBToAvc, buildAvcC, extractAac, findMoov };
