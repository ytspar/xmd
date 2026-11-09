import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPipeline, type ProgressEvent } from "../src/pipeline.js";
import { referenceImageKey } from "../src/reference-images.js";
import { captureTranscripts } from "../src/video-content.js";
import type { Thread } from "../src/types.js";
import type { VideoTranscript } from "../src/transcripts.js";
const dir=await fs.mkdtemp(path.join(os.tmpdir(),"tweetmd-reference-pipeline-"));
try {
 const imageUrl="https://publisher.example/figure.png";
 const videoUrl="https://www.youtube.com/watch?v=abcdefghijk";
 const t:Thread={main:{id:"123",url:"https://x.com/author/status/123",author:{handle:"author",name:"Author"},text:"Read https://publisher.example/article",createdAtRaw:"",metrics:{likes:0,retweets:0,replies:0,quotes:0},media:[],isMainTweet:true},ancestors:[],replies:[],capturedAt:"",sourceUrl:"https://x.com/author/status/123"};
 let captionCalls=0;
 const caption:VideoTranscript={status:"complete",provider:"youtube",sourceUrl:videoUrl,language:"en",automatic:false,fetchedAt:"2026-11-05T00:00:00Z",segments:[{startSeconds:1,endSeconds:2,text:"Actual captions"}],text:"Actual captions"};
 const events:ProgressEvent[]=[];
 for await(const event of runPipeline({url:t.sourceUrl,outBase:dir,headless:true,enrich:true,categorize:false}, {
  scrape:async()=>t,
  references:async(thread,out)=>{
   await fs.mkdir(path.join(out,"refs"),{recursive:true});
   const body=`# Source\n\nBefore\n\n[[reference-image:${referenceImageKey(imageUrl)}]]\n\nAfter`;
   await fs.writeFile(path.join(out,"refs/article.md"),body);
   thread.references=[{url:"https://publisher.example/article",sourceTweetId:"123",kind:"web",title:"Source",files:[{localPath:"refs/article.md",bytes:Buffer.byteLength(body)}],media:[{url:imageUrl,type:"photo"}],videos:[{url:videoUrl}],textStatus:"complete",status:"complete",imageDiscoveryVersion:"article-images-v1"},{url:videoUrl,sourceTweetId:"123",kind:"video",title:"Video",files:[]}];
  },
  media:async()=>{},
  referenceImages:async(ref,out)=>{
   if(!ref.media?.length)return;
   await fs.mkdir(path.join(out,"refs/media"),{recursive:true});
   await fs.writeFile(path.join(out,"refs/media/image.png"),"fixture");ref.media[0].localPath="refs/media/image.png";
  },
  enrich:async(thread)=>{
   for(const node of [thread.main,...thread.replies])for(const media of node.media)media.enrichment={kind:"text",content:"Recognized figure text",description:"Chart"};
   return {analyzed:1,failed:0};
  },
  provider:async()=>({available:true,authenticated:true}),
  transcripts:async(thread,out,opts)=>captureTranscripts(thread,out,{...opts,fetchTranscript:async()=>{captionCalls++;return caption;}}),
 }))events.push(event);
 const done=events.find(e=>e.type==="done");assert.ok(done?.type==="done");
 assert.equal(done.thread.capture?.stages.ocr.status,"complete");
 assert.equal(done.thread.capture?.stages.transcripts.status,"complete");
 assert.equal(done.thread.capture?.stages.references.status,"complete");
 assert.equal(captionCalls,1,"Duplicate embedded/direct video targets share a request");
 const article=done.thread.references![0];
 const rendered=await fs.readFile(path.join(done.result.outDir,article.files[0].localPath),"utf8");
 assert.match(rendered,/Before[\s\S]*Recognized figure text[\s\S]*After/);
 assert.match(rendered,/Actual captions/);
 assert.doesNotMatch(rendered,/\[\[reference-image:/);
 assert.ok(article.files[0].sourcePath);
 assert.equal(Buffer.byteLength(rendered),article.files[0].bytes);
 assert.ok(done.thread.references![1].files[0].localPath.startsWith("refs/transcripts/"));
 assert.doesNotMatch(done.thread.capture!.warnings.join(" "),/no transcript|transcript unavailable/);
 console.log("Linked-image OCR, caption deduplication, inline source rendering and coverage integration passed");
}finally{await fs.rm(dir,{recursive:true,force:true});}
