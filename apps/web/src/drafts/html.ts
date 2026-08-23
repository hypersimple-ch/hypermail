import sanitizeHtml from 'sanitize-html';

const fontFamily = /^(?:Arial|Tahoma|Verdana), sans-serif$|^(?:Georgia|Times New Roman), serif$/;
const fontSize = /^(?:12|14|18|24)px$/;

/** Canonical HTML subset supported by the browser editor and provider draft path. */
export function sanitizeDraftHtml(value: string): string {
  return sanitizeHtml(value, {
    allowedTags: ['p', 'br', 'strong', 'em', 'u', 's', 'span', 'ul', 'ol', 'li', 'blockquote'],
    allowedAttributes: { p: ['style'], span: ['style'] },
    allowedStyles: {
      p: { 'text-align': [/^(?:left|center|right)$/] },
      span: { 'font-family': [fontFamily], 'font-size': [fontSize] },
    },
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'],
    parseStyleAttributes: true,
  });
}
