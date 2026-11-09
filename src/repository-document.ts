/** Parse document images without treating fenced/inline code as live markup. */
import { fromMarkdown } from "mdast-util-from-markdown";
import { JSDOM } from "jsdom";
import { responsiveImage } from "./web-document.js";
import { canonicalReferenceImageUrl, referenceImageKey, type DiscoveredReferenceImage } from "./reference-images.js";

export const REPOSITORY_IMAGE_VERSION = "repository-images-v1";
export const REPOSITORY_DOCUMENT_VERSION = "repository-document-v1";

/** GitHub /blob links serve HTML; the corresponding raw URL serves bytes. */
export function repositoryImageUrl(input: string, baseUrl: string, rootUrl?: string): string | undefined {
  try {
    const value = input.trim();
    const url = new URL(value, value.startsWith("/") && !value.startsWith("//") && rootUrl ? rootUrl : baseUrl);
    if (value.startsWith("/") && !value.startsWith("//") && rootUrl) {
      // URL resolution would otherwise discard owner/repo/ref from the root.
      return repositoryImageUrl(value.slice(1), rootUrl.endsWith("/") ? rootUrl : rootUrl + "/");
    }
    if (url.protocol === "data:" && /^data:image\//i.test(value)) return value;
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    if (url.hostname === "github.com" && /^\/[^/]+\/[^/]+\/(?:blob|raw)\//.test(url.pathname)) {
      url.hostname = "raw.githubusercontent.com";
      url.pathname = url.pathname.replace(/^(\/[^/]+\/[^/]+)\/(?:blob|raw)\//, "$1/");
      url.searchParams.delete("raw");
    }
    return canonicalReferenceImageUrl(url.toString());
  } catch { return undefined; }
}

export function extractRepositoryDocument(text: string, baseUrl: string, rootUrl?: string): { text: string; images: DiscoveredReferenceImage[]; warning?: string } {
  const tree = fromMarkdown(text);
  type Node = { type: string; children?: Node[]; url?: string; alt?: string | null; title?: string | null; identifier?: string; value?: string; position?: {start:{offset?:number};end:{offset?:number}} };
  const definitions = new Map<string, Node>();
  const edits: {start:number;end:number;value:string}[] = [];
  const images = new Map<string, DiscoveredReferenceImage>();
  const warnings = new Set<string>();
  const blocked: {start:number;end:number}[] = [];
  const visit = (node: Node, fn: (node:Node)=>void) => {fn(node);node.children?.forEach(child=>visit(child,fn));};
  visit(tree, node => {
    if (node.type === "definition" && node.identifier) definitions.set(node.identifier.toLowerCase(), node);
    if (["code", "inlineCode"].includes(node.type) && node.position) blocked.push({start:node.position.start.offset!,end:node.position.end.offset!});
  });
  // RST literal/code blocks may use three-space indentation, which a Markdown
  // AST does not recognize as code. Keep their example directives untouched.
  const lines=text.match(/[^\n]*(?:\n|$)/g) ?? [];
  let offset=0;
  for(let index=0;index<lines.length;index++){
    const line=lines[index],start=offset;offset+=line.length;
    const directive=/^([ \t]*)\.\. (?:code-block|code|sourcecode|parsed-literal)::/.test(line);
    const literal=!/^\s*\.\.\s/.test(line)&&/[^:]::\s*$/.test(line);
    if(!directive&&!literal)continue;
    const indent=(line.match(/^[ \t]*/)?.[0]??"").replace(/\t/g,"    ").length;
    let end=offset;
    for(let next=index+1;next<lines.length;next++){
      const content=lines[next];
      const width=(content.match(/^[ \t]*/)?.[0]??"").replace(/\t/g,"    ").length;
      if(content.trim()&&width<=indent)break;
      end+=content.length;
    }
    if(end>offset)blocked.push({start,end});
  }
  const marker = (url: string | undefined, altText?: string | null, caption?: string | null) => {
    if (!url) {warnings.add("Some repository document images have unsupported or unresolved URLs.");return undefined;}
    const old = images.get(url);
    images.set(url, {url,altText:old?.altText || altText || undefined,caption:old?.caption || caption || undefined});
    return `[[reference-image:${referenceImageKey(url)}]]`;
  };
  visit(tree, node => {
    if (!node.position) return;
    const start=node.position.start.offset!;
    let end=node.position.end.offset!;
    if(blocked.some(range=>start>=range.start&&end<=range.end))return;
    if(edits.some(edit=>start>=edit.start&&end<=edit.end))return;
    if(node.type === "link" || node.type === "linkReference"){
      const children:Node[]=[];visit(node,child=>{if(["image","imageReference"].includes(child.type))children.push(child);});
      if(!children.length)return;
      const parts=children.map(child=>{
        const source=child.type==="imageReference"?definitions.get(child.identifier?.toLowerCase()??""):child;
        return marker(source?.url?repositoryImageUrl(source.url,baseUrl,rootUrl):undefined,child.alt,source?.title);
      });
      const target=node.type==="linkReference"?definitions.get(node.identifier?.toLowerCase()??""):node;
      const href=target?.url?repositoryImageUrl(target.url,baseUrl,rootUrl):undefined;
      const label:string[]=[];visit(node,child=>{if(child.type==="text"&&child.value)label.push(child.value);});
      const link=href?`[${label.join(" ").replace(/[\[\]\n]/g," ").trim()||"Image link"}](${href})`:"";
      edits.push({start,end,value:`\n\n${parts.filter(Boolean).join("\n\n")}\n\n${link}\n\n`});
    } else if (node.type === "image" || node.type === "imageReference") {
      const source = node.type === "imageReference" ? definitions.get(node.identifier?.toLowerCase() ?? "") : node;
      const value=marker(source?.url ? repositoryImageUrl(source.url,baseUrl,rootUrl) : undefined,node.alt,source?.title);
      if (value) edits.push({start,end,value});
    } else if (node.type === "html" && /<(?:img|picture)\b|^<a\b/i.test(node.value ?? "")) {
      let html=node.value ?? "";
      // CommonMark treats picture as inline HTML, so its source/img children
      // can arrive as separate AST nodes. Parse the complete picture together.
      if(/^<picture\b/i.test(html)&&!/<\/picture>/i.test(html)){
        const close=/<\/picture\s*>/i.exec(text.slice(end));
        if(close){end+=close.index+close[0].length;html=text.slice(start,end);}
      }
      if(/^<a\b/i.test(html)&&!/<\/a>/i.test(html)){
        const close=/<\/a\s*>/i.exec(text.slice(end));
        if(close){end+=close.index+close[0].length;html=text.slice(start,end);}
      }
      const dom=new JSDOM(html);
      try {
        let changed=false;
        for(const anchor of dom.window.document.querySelectorAll("a"))if(anchor.querySelector("img")){
          const href=anchor.getAttribute("href");
          const url=href?repositoryImageUrl(href,baseUrl,rootUrl):undefined;
          anchor.replaceWith(...anchor.childNodes,dom.window.document.createTextNode(url?`\n\n[Image link](${url})\n\n`:""));
        }
        for(const image of dom.window.document.querySelectorAll("img")) {
          const url=responsiveImage(image,baseUrl,(value,base)=>value ? repositoryImageUrl(value,base,rootUrl) : undefined);
          const value=marker(url,image.getAttribute("alt"),image.getAttribute("title"));
          if(value){(image.closest("picture") ?? image).replaceWith(dom.window.document.createTextNode(value));changed=true;}
        }
        if(changed)edits.push({start,end,value:dom.window.document.body.innerHTML});
      }finally{dom.window.close();}
    }
  });
  // reStructuredText's explicit image/figure directive is common in READMEs.
  for(const match of text.matchAll(/^([ \t]*)\.\. (?:image|figure)::[ \t]*(\S+)[^\n]*(?:\n[ \t]+:[\w-]+:[^\n]*)*/gm)) {
    const start=match.index!,end=start+match[0].length;
    if(blocked.some(range=>range.start<=start&&range.end>=end)||edits.some(edit=>start<edit.end&&end>edit.start))continue;
    const alt=match[0].match(/\n\s+:alt:\s*(.*)/)?.[1];
    const value=marker(repositoryImageUrl(match[2],baseUrl,rootUrl),alt);
    if(value)edits.push({start,end,value});
  }
  for(const edit of edits.sort((a,b)=>b.start-a.start))text=text.slice(0,edit.start)+edit.value+text.slice(edit.end);
  return {text,images:[...images.values()],warning:[...warnings].join(" ")||undefined};
}
