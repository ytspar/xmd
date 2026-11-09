/** Bounded WOFF1 decompression for a renderer that consumes OpenType fonts. */
import { inflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";

const MAX_FONT_BYTES = 4 * 1024 * 1024;
export function svgFontToSfnt(input: Buffer): Buffer {
  if(input.length<12 || input.length>MAX_FONT_BYTES)throw new Error("SVG font byte limit or truncated header");
  const magic=input.toString("ascii",0,4);
  if(magic==="wOF2")throw new Error("SVG WOFF2 fonts are not supported");
  if(magic!=="wOFF"){
    if(magic!=="OTTO"&&input.readUInt32BE(0)!==0x00010000)throw new Error("Unsupported SVG font format");
    const count=input.readUInt16BE(4);
    if(!count||count>128||12+16*count>input.length)throw new Error("Invalid SVG font table directory");
    for(let i=0;i<count;i++){
      const entry=12+i*16,offset=input.readUInt32BE(entry+8),length=input.readUInt32BE(entry+12);
      if(offset<12+16*count||offset+length>input.length)throw new Error("Invalid SVG font table bounds");
    }
    return input;
  }
  if(input.length<44||input.readUInt32BE(8)!==input.length)throw new Error("Invalid SVG WOFF length");
  const count=input.readUInt16BE(12),total=input.readUInt32BE(16);
  if(input.readUInt16BE(14)!==0||!count||count>128||44+20*count>input.length||total>MAX_FONT_BYTES||total<12+16*count)throw new Error("Invalid SVG WOFF directory/size");
  const output=Buffer.alloc(total),power=2**Math.floor(Math.log2(count));
  input.copy(output,0,4,8);output.writeUInt16BE(count,4);output.writeUInt16BE(power*16,6);output.writeUInt16BE(Math.log2(power),8);output.writeUInt16BE(count*16-power*16,10);
  let cursor=12+16*count;
  const tags=new Set<string>();
  for(let i=0;i<count;i++){
    const source=44+20*i,destination=12+16*i;
    const tag=input.toString("ascii",source,source+4),offset=input.readUInt32BE(source+4),compressed=input.readUInt32BE(source+8),length=input.readUInt32BE(source+12);
    if(tags.has(tag)||!compressed||compressed>length||offset<44+20*count||offset+compressed>input.length||cursor+length>total)throw new Error("Invalid SVG WOFF table bounds");
    tags.add(tag);
    const data=input.subarray(offset,offset+compressed);
    const bytes=compressed===length?data:inflateSync(data,{maxOutputLength:length});
    if(bytes.length!==length)throw new Error("Invalid SVG WOFF decompressed size");
    input.copy(output,destination,source,source+4);input.copy(output,destination+4,source+16,source+20);
    output.writeUInt32BE(cursor,destination+8);output.writeUInt32BE(length,destination+12);bytes.copy(output,cursor);
    cursor+=(length+3)&~3;
  }
  if(cursor!==total)throw new Error("SVG WOFF reconstructed size mismatch");
  return output;
}

/** Declared CSS families must match a font the offline renderer can select. */
export function svgFontFamilyNames(input:Buffer):string[]{
  const font=svgFontToSfnt(input),count=font.readUInt16BE(4),names=new Set<string>();
  for(let i=0;i<count;i++){
    const entry=12+16*i;if(font.toString("ascii",entry,entry+4)!=="name")continue;
    const start=font.readUInt32BE(entry+8),length=font.readUInt32BE(entry+12);
    if(length<6)throw new Error("Invalid SVG font name table");
    const records=font.readUInt16BE(start+2),storage=font.readUInt16BE(start+4);
    if(6+records*12>length||storage<6+records*12||storage>length)throw new Error("Invalid SVG font name records");
    for(let n=0;n<records;n++){
      const record=start+6+12*n,platform=font.readUInt16BE(record),id=font.readUInt16BE(record+6),size=font.readUInt16BE(record+8),offset=font.readUInt16BE(record+10);
      if(storage+offset+size>length)throw new Error("Invalid SVG font name string bounds");
      if(![1,16].includes(id))continue;
      const bytes=Buffer.from(font.subarray(start+storage+offset,start+storage+offset+size));
      let value:string;
      if(platform===0||platform===3){if(bytes.length%2)throw new Error("Invalid SVG Unicode font name");bytes.swap16();value=bytes.toString("utf16le");}
      else if(platform===1)value=bytes.toString("latin1");else continue;
      if(value.trim())names.add(value.trim());
    }
  }
  return [...names];
}

/** A name table alone is insufficient: prove the offline renderer loads glyphs. */
export function verifySvgFontRendering(file:string,family:string):void{
  const escaped=family.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");
  const probe=new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="40"><text x="2" y="30" font-family="${escaped}">Aa012Ω</text></svg>`,{font:{fontFiles:[file],loadSystemFonts:false}});
  if(!/<path\b[^>]*\bd="[^"]*[A-Za-z][^"]*"/.test(probe.toString()))throw new Error("SVG font cannot render verified glyphs; fallback rendering was refused");
}
