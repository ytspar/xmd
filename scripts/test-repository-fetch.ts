import "./fixtures/public-dns.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fetchReferences } from "../src/links.js";
import type { Thread } from "../src/types.js";

const dir=await fs.mkdtemp(path.join(os.tmpdir(),"tweetmd-repository-fetch-"));
const original=globalThis.fetch;
const thread:Thread={main:{id:"1",url:"https://x.com/a/status/1",author:{handle:"a",name:"A"},text:"https://github.com/acme/project https://github.com/acme/project/blob/release/docs/guide.md https://gist.github.com/acme/abc123",createdAtRaw:"",metrics:{likes:0,retweets:0,replies:0,quotes:0},media:[],isMainTweet:true},ancestors:[],replies:[],capturedAt:"",sourceUrl:"https://x.com/a/status/1"};
const requests:string[]=[];
try{
 globalThis.fetch=async(input)=>{
  const url=String(input);requests.push(url);
  if(url==="https://api.github.com/repos/acme/project/readme")return Response.json({path:"docs/README.md",download_url:"https://raw.githubusercontent.com/acme/project/stable/docs/README.md",encoding:"base64",content:Buffer.from("# Project\n\n![Relative](images/chart.png)\n![Root](/assets/root.svg)").toString("base64")});
  if(url==="https://raw.githubusercontent.com/acme/project/release/docs/guide.md")return new Response("# Guide\n\n![Figure](../assets/figure.png)");
  if(url==="https://api.github.com/gists/abc123")return Response.json({files:{one:{filename:"one.md",content:"![One](one.png)",raw_url:"https://gist.githubusercontent.com/acme/abc123/raw/revision/one.md"},two:{filename:"two.md",content:"![Two](two.png)",raw_url:"https://gist.githubusercontent.com/acme/abc123/raw/revision/two.md"}}});
  return new Response("missing",{status:404});
 };
 await fs.mkdir(path.join(dir,"refs"));await fs.writeFile(path.join(dir,"refs/old.md"),"Earlier source");
 thread.references=[{url:"https://github.com/acme/project",title:"Project",kind:"github-repo",sourceTweetId:"1",status:"partial",warning:"Repository/registry document images are retained as source links; image bytes and OCR are not captured.",files:[{localPath:"refs/old.md",bytes:14}]}];
 await fetchReferences(thread,dir,{resume:true});
 const repo=thread.references!.find(r=>r.url==="https://github.com/acme/project")!;
 assert.deepEqual(repo.media?.map(m=>m.url),["https://raw.githubusercontent.com/acme/project/stable/docs/images/chart.png","https://raw.githubusercontent.com/acme/project/stable/assets/root.svg"]);
 assert.equal(repo.imageDiscoveryVersion,"repository-images-v1");assert.equal(repo.extractionVersion,"repository-document-v1");assert.equal(repo.warning,undefined);
 assert.equal(repo.finalUrl,"https://raw.githubusercontent.com/acme/project/stable/docs/README.md");
 const guide=thread.references!.find(r=>r.kind==="github-file")!;assert.equal(guide.media?.[0].url,"https://raw.githubusercontent.com/acme/project/release/assets/figure.png");
 const gist=thread.references!.find(r=>r.kind==="gist")!;assert.equal(gist.files.length,2);assert.equal(gist.media?.length,2);
 assert.ok(gist.media?.some(m=>m.url==="https://gist.githubusercontent.com/acme/abc123/raw/revision/one.png"));
 const before=requests.length;await fetchReferences(thread,dir,{resume:true});assert.equal(requests.length,before,"Current, intact document extractions are reused");
 assert.equal(await fs.readFile(path.join(dir,"refs/old.md"),"utf8"),"Earlier source","Upgrading preserves the earlier on-disk source copy");
 const fallback:Thread={...thread,main:{...thread.main,text:"https://github.com/acme/fallback"},references:undefined};
 globalThis.fetch=async(input,options)=>{
  if(String(input)==="https://api.github.com/repos/acme/fallback/readme"&&new Headers(options?.headers).get("accept")==="application/vnd.github.raw")return new Response("# Saved README\n\n![Unknown base](images/chart.png)");
  return new Response("missing",{status:404});
 };
 await fetchReferences(fallback,dir);
 assert.equal(fallback.references![0].status,"partial");assert.match(fallback.references![0].warning!,/unverified|could not be verified/);assert.equal(fallback.references![0].media?.length,0);
 const truncated:Thread={...thread,main:{...thread.main,text:"https://github.com/acme/truncated"},references:undefined};
 globalThis.fetch=async(input)=>{
  const url=String(input);
  if(url==="https://api.github.com/repos/acme/truncated/readme")return Response.json({path:"README.md",download_url:"https://raw.githubusercontent.com/acme/truncated/stable/README.md",encoding:"base64",size:1000,content:Buffer.from("# Incomplete prefix").toString("base64")});
  if(url==="https://raw.githubusercontent.com/acme/truncated/stable/README.md")return new Response("# Full README\n\n![Full figure](images/full.png)");
  return new Response("missing",{status:404});
 };
 await fetchReferences(truncated,dir);assert.equal(truncated.references![0].status,"complete");assert.match(truncated.references![0].media![0].url,/stable\/images\/full.png$/);
 console.log("GitHub verified default branch/path, relative files, multi-file gist union and legacy resume upgrade passed");
}finally{globalThis.fetch=original;await fs.rm(dir,{recursive:true,force:true});}
