// A small, forgiving XML reader (Tally's XML is not always strictly valid; the sanctions lists are fine but big enough that a
// plain tree is all we need). Extracted from the Tally connector. No namespaces, no DTDs, no entity expansion beyond the basics.

export type XNode = { name: string; text: string; kids: XNode[]; attrs: Record<string, string> };

// Control characters, often written as numeric references like &#4; which XML 1.0 forbids. Drop them, keep tab / newline.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return NAMED[e.toLowerCase()] ?? all; // an unknown entity stays as written
  }).replace(CONTROL, "");
}

const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Reads XML into a tree of element names, text, attributes and children. Element names keep their case unless `upperNames`
 * is set (Tally's tags are compared in upper case). Attribute names always keep their case.
 */
export function parseXml(xml: string, opts: { upperNames?: boolean } = {}): XNode {
  const src = xml.replace(/^﻿/, "").replace(CONTROL, " ");
  const root: XNode = { name: "#root", text: "", kids: [], attrs: {} };
  const stack: XNode[] = [root];
  const fold = (s: string) => (opts.upperNames ? s.toUpperCase() : s);
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (lt < 0) { top.text += decode(src.slice(i)); break; }
    if (lt > i) top.text += decode(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt + 4); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith("<![CDATA[", lt)) { const e = src.indexOf("]]>", lt + 9); top.text += src.slice(lt + 9, e < 0 ? src.length : e); i = e < 0 ? src.length : e + 3; continue; }
    if (src[lt + 1] === "?" || src[lt + 1] === "!") { const e = src.indexOf(">", lt); i = e < 0 ? src.length : e + 1; continue; }
    // Find the end of the tag, skipping any ">" inside quoted attribute values.
    let j = lt + 1, quote = "";
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) { if (c === quote) quote = ""; } else if (c === '"' || c === "'") quote = c; else if (c === ">") break;
    }
    const inner = src.slice(lt + 1, j);
    i = j + 1;
    if (inner[0] === "/") {
      const name = fold(inner.slice(1).trim());
      // Close the nearest open element of that name; a stray closing tag with no match is ignored.
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      continue;
    }
    const raw = /^[^\s/>]+/.exec(inner)?.[0];
    if (!raw) continue;
    const node: XNode = { name: fold(raw), text: "", kids: [], attrs: {} };
    if (inner.length > raw.length) for (const m of inner.slice(raw.length).matchAll(ATTR)) node.attrs[m[1]] = decode(m[2] ?? m[3] ?? "");
    top.kids.push(node);
    if (!inner.endsWith("/")) stack.push(node);
  }
  return root;
}

/** Direct children with this name. */
export const kids = (n: XNode, name: string) => n.kids.filter((k) => k.name === name);
/** Trimmed text of the first direct child with this name, or "". */
export const text = (n: XNode, name: string) => kids(n, name)[0]?.text.trim() ?? "";
