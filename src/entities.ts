/**
 * HTML entity decoding, shared by the web-page extractor (links.ts) and the X
 * data parsers (article.ts, x-parse.ts) so titles/tweet text decode the same
 * named entities (&mdash;, &eacute;, …) as fetched web content.
 */

// Common named HTML entities — punctuation and Latin-1 accents cover almost all
// real-world prose; unknown names are left as-is rather than guessed.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„",
  bull: "•", middot: "·", dagger: "†", Dagger: "‡", prime: "′", Prime: "″",
  trade: "™", copy: "©", reg: "®", deg: "°", plusmn: "±", times: "×", divide: "÷",
  permil: "‰", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶",
  laquo: "«", raquo: "»", iexcl: "¡", iquest: "¿", minus: "−",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ",
  ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê", euml: "ë",
  igrave: "ì", iacute: "í", icirc: "î", iuml: "ï", ntilde: "ñ",
  ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yuml: "ÿ", szlig: "ß",
  Agrave: "À", Aacute: "Á", Auml: "Ä", Ccedil: "Ç", Egrave: "È", Eacute: "É",
  Iacute: "Í", Ntilde: "Ñ", Oacute: "Ó", Ouml: "Ö", Uacute: "Ú", Uuml: "Ü",
};

function cp(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** Decode numeric, hex, and common named HTML entities; leave unknown names as-is. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, n) => cp(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => cp(parseInt(n, 16)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name: string) => NAMED_ENTITIES[name] ?? m);
}
