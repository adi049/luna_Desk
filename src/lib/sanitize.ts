/**
 * Minimal allow-list sanitiser for rich-text notes.
 *
 * Notes are authored with a contentEditable surface, so their HTML is untrusted
 * input. We never inject raw HTML: the string is parsed with DOMParser, only
 * allow-listed elements/attributes survive, and unsafe URL schemes are dropped.
 */
const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'BR', 'P', 'DIV', 'UL', 'OL', 'LI', 'H3', 'BLOCKQUOTE', 'A', 'CODE', 'PRE', 'SPAN']);
const ALLOWED_ATTRS: Record<string, string[]> = { A: ['href', 'title'] };

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (node: Node) => {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement;
        if (!ALLOWED.has(el.tagName)) {
          // Keep the text, ditch the element.
          const text = document.createTextNode(el.textContent ?? '');
          el.replaceWith(text);
          continue;
        }
        for (const attr of Array.from(el.attributes)) {
          const allowed = ALLOWED_ATTRS[el.tagName] ?? [];
          if (!allowed.includes(attr.name)) el.removeAttribute(attr.name);
        }
        if (el.tagName === 'A') {
          const href = el.getAttribute('href') ?? '';
          if (!/^https?:\/\//i.test(href)) el.removeAttribute('href');
          el.setAttribute('rel', 'noopener noreferrer');
          el.setAttribute('target', '_blank');
        }
        walk(el);
      } else if (child.nodeType !== Node.TEXT_NODE) {
        child.remove();
      }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent?.trim() ?? '';
}
