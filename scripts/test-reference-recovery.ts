import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureTranscripts } from "../src/video-content.js";
import { updateReferenceCoverage, renderReferenceDocuments } from "../src/reference-content.js";
import { classificationContext } from "../src/categorize.js";
import type { LinkedReference, Thread } from "../src/types.js";
import type { VideoTranscript } from "../src/transcripts.js";
const dir=await fs.mkdtemp(path.join(os.tmpdir(),"tweetmd-reference-recovery-"));
try{
 const partial:VideoTranscript={status:"partial",sourceUrl:"https://youtu.be/abcdefghijk",provider:"youtube",language:"en",fetchedAt:"",text:"Saved partial caption text",segments:[{startSeconds:1,endSeconds:2,text:"Saved partial caption text"}],truncated:true};
 const ref:LinkedReference={url:partial.sourceUrl,title:"Video",kind:"video",files:[],sourceTweetId:"1",transcript:partial};
 const t:Thread={main:{id:"1",url:"https://x.com/a/status/1",author:{name:"A",handle:"a"},text:"Watch this",media:[],metrics:{likes:0,retweets:0,replies:0,quotes:0},createdAtRaw:"",isMainTweet:true},ancestors:[],replies:[],capturedAt:"",sourceUrl:"https://x.com/a/status/1",references:[ref]};
 await captureTranscripts(t,dir,{resume:true,fetchTranscript:async()=>({...partial,status:"unavailable",text:"",segments:[],error:"Blocked"})});
 assert.equal(ref.transcript?.text,partial.text);assert.equal(ref.transcript?.status,"partial");assert.match(ref.transcript!.error!,/retained/);assert.ok(ref.files.length);
 const image:LinkedReference={url:"https://example.com/article",kind:"web",title:"Article",sourceTweetId:"1",files:[{localPath:"refs/missing.md",sourcePath:"refs/lost-source.md",bytes:0}],textStatus:"complete",media:[{url:"https://example.com/image.png",type:"photo",localPath:"refs/media/missing.png",downloadError:"Unavailable",enrichment:{kind:"text",content:"Saved OCR"}}]};
 updateReferenceCoverage(image);assert.equal(image.status,"partial");assert.match(image.warning!,/not downloaded/);
 t.references=[image];await renderReferenceDocuments(t,dir);assert.equal(image.status,"partial");assert.match(image.error!,/rendering unavailable/);
 const readme:LinkedReference={url:"https://github.com/a/b",kind:"github-repo",title:"README",sourceTweetId:"1",files:[{localPath:"README.md",bytes:0}],status:"complete"};
 await fs.writeFile(path.join(dir,"README.md"),"![Diagram](docs/diagram.png)");
 t.references=[readme];await renderReferenceDocuments(t,dir);assert.equal(readme.status,"partial");assert.match(readme.warning!,/image bytes and OCR are not captured/);
 t.references=[image];
 t.main.media=[{url:"https://pbs.twimg.com/poster.jpg",type:"video",transcript:{...partial,text:"Native caption topic: binary search"}}];
 image.videos=[{url:partial.sourceUrl,transcript:{...partial,text:"Embedded caption topic: graph traversal"}}];
 const context=await classificationContext(t,dir);assert.match(context,/binary search/);assert.match(context,/graph traversal/);
 console.log("Partial caption preservation, source-render isolation, missing image coverage and caption classification passed");
}finally{await fs.rm(dir,{recursive:true,force:true});}
