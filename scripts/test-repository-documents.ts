import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractRepositoryDocument, repositoryImageUrl } from "../src/repository-document.js";
import { renderReferenceDocuments, updateReferenceCoverage } from "../src/reference-content.js";
import type { Thread, LinkedReference } from "../src/types.js";

const base="https://raw.githubusercontent.com/owner/repo/release/docs/guide/README.md";
const root="https://raw.githubusercontent.com/owner/repo/release/";
const raw=`# Document

Before ![Throughput](../images/chart(1).png "Figure 1") after.

![Root](/assets/root.png)
![Remote](https://cdn.example/diagram.svg)
![Reference][fig]
![Reference]

[fig]: <../images/reference.png> "Measured results"
[Reference]: ../images/reference.png

<picture><source srcset="/assets/small.png 100w, /assets/large.png 1000w"><img src="fallback.png" alt="Responsive"></picture>

<img src='../images/html.png' alt='HTML figure'>

\`![Inline example](not-an-image.png)\`

\`\`\`md
![Code example](also-not-an-image.png)
<img src="code-only.png">
\`\`\`

.. image:: ../images/rst.png
   :alt: RST diagram

![Unsafe](javascript:alert)
`;
const result=extractRepositoryDocument(raw,base,root);
assert.equal(result.images.length,7);
assert.ok(result.images.some(i=>i.url===root+"docs/images/chart(1).png"&&i.caption==="Figure 1"));
assert.ok(result.images.some(i=>i.url===root+"assets/root.png"));
assert.ok(result.images.some(i=>i.url===root+"assets/large.png"));
assert.ok(result.images.some(i=>i.url===root+"docs/images/rst.png"&&i.altText==="RST diagram"));
assert.equal(result.images.filter(i=>i.url.endsWith("reference.png")).length,1);
assert.match(result.text,/Before \[\[reference-image:[a-f0-9]+\]\] after/);
assert.match(result.text,/!\[Inline example\]\(not-an-image.png\)/);
assert.match(result.text,/!\[Code example\]\(also-not-an-image.png\)/);
assert.ok(!result.images.some(i=>/not-an-image|code-only/.test(i.url)));
assert.match(result.warning!,/unsupported or unresolved/);
assert.equal(repositoryImageUrl("https://github.com/a/b/blob/branch/assets/chart.png?raw=true",base),"https://raw.githubusercontent.com/a/b/branch/assets/chart.png");
assert.equal(repositoryImageUrl("//cdn.example/chart.png",base,root),"https://cdn.example/chart.png");
assert.equal(repositoryImageUrl("file:///etc/passwd",base),undefined);
assert.equal(repositoryImageUrl("https://user:secret@example.com/image.png",base),undefined);
const rst=extractRepositoryDocument(".. code-block:: rst\n\n   .. image:: example.png\n      :alt: sample\n\nLiteral example::\n\n   .. image:: literal.png\n\n.. image:: actual.png\n   :alt: real",base,root);
assert.deepEqual(rst.images.map(i=>i.url),[root+"docs/guide/actual.png"]);
assert.match(rst.text,/\.\. image:: example.png/);assert.match(rst.text,/\.\. image:: literal.png/);
const wrapped=extractRepositoryDocument('[![Demo](docs/demo.png)](https://example.com/demo)\n\n<a href="https://example.com/html"><img src="docs/html.png" alt="HTML"></a>',base,root);
assert.equal(wrapped.images.length,2);assert.doesNotMatch(wrapped.text,/\[\[\[reference-image:|<a\b/);
assert.match(wrapped.text,/\[Image link\]\(https:\/\/example.com\/demo\)/);assert.match(wrapped.text,/\[Image link\]\(https:\/\/example.com\/html\)/);

const dir=await fs.mkdtemp(path.join(os.tmpdir(),"tweetmd-repository-documents-"));
try{
 await fs.mkdir(path.join(dir,"refs"));await fs.writeFile(path.join(dir,"refs/README.md"),result.text);
 const ref:LinkedReference={url:"https://github.com/owner/repo",kind:"github-repo",sourceTweetId:"1",title:"README",files:[{localPath:"refs/README.md",bytes:Buffer.byteLength(result.text)}],media:result.images.map(i=>({...i,type:"photo",localPath:"refs/media/test.png",enrichment:{kind:"text",description:"Figure",content:"Recognized measurements"}})),imageDiscoveryVersion:"repository-images-v1",textStatus:"complete"};
 const thread:Thread={main:{id:"1",url:"https://x.com/a/status/1",author:{handle:"a",name:"A"},text:"",createdAtRaw:"",metrics:{likes:0,retweets:0,replies:0,quotes:0},media:[],isMainTweet:true},ancestors:[],replies:[],capturedAt:"",sourceUrl:"",references:[ref]};
 updateReferenceCoverage(ref);assert.equal(ref.status,"complete");
 await renderReferenceDocuments(thread,dir);const first=await fs.readFile(path.join(dir,ref.files[0].localPath),"utf8");
 assert.match(first,/Recognized measurements/);assert.doesNotMatch(first,/\[\[reference-image:/);
 assert.ok(ref.files[0].sourcePath);assert.equal(Buffer.byteLength(first),ref.files[0].bytes);
 await renderReferenceDocuments(thread,dir);assert.equal(await fs.readFile(path.join(dir,ref.files[0].localPath),"utf8"),first);
 console.log("Repository relative/root/remote/reference/HTML/RST images, code exclusion, rendering and resume checks passed");
}finally{await fs.rm(dir,{recursive:true,force:true});}
