import assert from "node:assert/strict";
import {deflateSync} from "node:zlib";
import {svgFontToSfnt,svgFontFamilyNames,verifySvgFontRendering} from "../src/svg-fonts.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const table=Buffer.alloc(256,42),compressed=deflateSync(table);
const woff=Buffer.alloc(64+compressed.length);
woff.write("wOFF");woff.write("OTTO",4);woff.writeUInt32BE(woff.length,8);woff.writeUInt16BE(1,12);woff.writeUInt32BE(284,16);
woff.write("CFF ",44);woff.writeUInt32BE(64,48);woff.writeUInt32BE(compressed.length,52);woff.writeUInt32BE(table.length,56);compressed.copy(woff,64);
const sfnt=svgFontToSfnt(woff);
assert.equal(sfnt.length,284);assert.equal(sfnt.toString("ascii",0,4),"OTTO");assert.equal(sfnt.readUInt32BE(20),28);assert.deepEqual(sfnt.subarray(28),table);
assert.deepEqual(svgFontToSfnt(sfnt),sfnt);
const invalid=Buffer.from(woff);invalid.writeUInt32BE(10_000_000,56);assert.throws(()=>svgFontToSfnt(invalid),/bounds/);
const oversized=Buffer.from(woff);oversized.writeUInt32BE(8*1024*1024,16);assert.throws(()=>svgFontToSfnt(oversized),/size/);
const wrongSize=Buffer.from(woff);wrongSize.writeUInt32BE(252,56);assert.throws(()=>svgFontToSfnt(wrongSize));
assert.throws(()=>svgFontToSfnt(Buffer.from("wOF2".padEnd(50))),/WOFF2/);
const directory=await fs.mkdtemp(path.join(os.tmpdir(),"tweetmd-font-proof-"));
try{
 const family=Buffer.from("Malformed Font","utf16le").swap16(),name=Buffer.alloc(18+family.length);
 name.writeUInt16BE(1,2);name.writeUInt16BE(18,4);name.writeUInt16BE(3,6);name.writeUInt16BE(1,8);name.writeUInt16BE(0x409,10);name.writeUInt16BE(1,12);name.writeUInt16BE(family.length,14);family.copy(name,18);
 const malformed=Buffer.alloc(28+name.length);malformed.writeUInt32BE(0x00010000);malformed.writeUInt16BE(1,4);malformed.write("name",12);malformed.writeUInt32BE(28,20);malformed.writeUInt32BE(name.length,24);name.copy(malformed,28);
 const file=path.join(directory,"name-only.ttf");await fs.writeFile(file,malformed);
 assert.deepEqual(svgFontFamilyNames(malformed),["Malformed Font"]);
 assert.throws(()=>verifySvgFontRendering(file,"Malformed Font"),/fallback rendering was refused/);
 let real:string|undefined;
 for(const candidate of [process.env.TWEETMD_TEST_FONT,"/System/Library/Fonts/Supplemental/Arial.ttf","/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf","C:\\Windows\\Fonts\\arial.ttf"].filter((p):p is string=>!!p))if(await fs.stat(candidate).then(s=>s.isFile()).catch(()=>false)){real=candidate;break;}
 if(real){const names=svgFontFamilyNames(await fs.readFile(real));assert.ok(names.length);verifySvgFontRendering(real,names[0]);console.log("Real font glyph rendering verified with system font");}
 else console.log("System font glyph fixture unavailable; live SVG font proof is required separately");
}finally{await fs.rm(directory,{recursive:true,force:true});}
console.log("Bounded WOFF conversion, table offsets, decompression limits and malformed font rejection passed");
