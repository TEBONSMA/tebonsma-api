import { convert } from 'html-to-text'
import sanitizeHtml from 'sanitize-html'

const IMAGE_DATA = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i

export interface IncomingOptions {
  // Pictures that came with the mail (cid:), as data addresses
  inline: Map<string, string>
  showImages: boolean
}

// A mail from anyone is shown to the member, so only formatting gets through: no script,
// forms, frames or event handlers. Pictures on other sites are left out until asked for,
// since loading them tells the sender that the mail was opened.
export function sanitizeIncoming(html: string, { inline, showImages }: IncomingOptions) {
  let blocked = 0
  const clean = sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'font', 'center'],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      font: ['color', 'size', 'face'],
      '*': ['style', 'align', 'valign', 'colspan', 'rowspan', 'width', 'height', 'bgcolor', 'dir'],
    },
    allowedStyles: {
      '*': {
        color: [/^[#\w(),.% -]+$/i],
        'background-color': [/^[#\w(),.% -]+$/i],
        'text-align': [/^(left|right|center|justify)$/],
        'font-size': [/^[\d.]+(px|pt|em|rem|%)$/],
        'font-weight': [/^(normal|bold|\d+)$/],
        'font-style': [/^(normal|italic)$/],
        'text-decoration': [/^(none|underline|line-through)$/],
        width: [/^[\d.]+(px|%)$/],
        height: [/^[\d.]+(px|%)$/],
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['data', 'http', 'https'] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
      img: (tagName, attribs) => {
        const src = attribs.src ?? ''
        const attributes = { ...attribs }
        delete attributes.src
        if (src.toLowerCase().startsWith('cid:')) {
          const data = inline.get(src.slice(4).replace(/^<|>$/g, ''))
          if (data) attributes.src = data
        } else if (IMAGE_DATA.test(src)) {
          attributes.src = src
        } else if (/^https?:\/\//i.test(src)) {
          if (showImages) attributes.src = src
          else blocked++
        }
        return { tagName, attribs: attributes }
      },
    },
    // A picture that can't be shown has nothing to show
    exclusiveFilter: frame => frame.tag === 'img' && !frame.attribs.src,
  })
  return { html: clean, blockedImages: blocked }
}

// What members write in the editor: paragraphs, simple formatting, lists, quotes and links
export const sanitizeCompose = (html: string) =>
  sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'a', 'h2', 'h3', 'hr', 'code', 'pre'],
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    transformTags: { a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: 'noopener noreferrer' } }) },
  })

// The plain text alternative of a mail, and what the feed gets when a mail is shared there
export const toText = (html: string) =>
  convert(html, {
    wordwrap: 78,
    selectors: [
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'h3', options: { uppercase: false } },
    ],
  }).trim()

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

// For mails that came without HTML
export const textToHtml = (text: string) =>
  `<div style="white-space:pre-wrap">${text.replace(/[&<>"]/g, ch => ESCAPES[ch])}</div>`

// The first words of a mail, for the message list
export function previewOf(text: string | undefined, html: string | false | undefined) {
  const plain = text?.trim() || (html ? toText(sanitizeCompose(html)) : '')
  return plain.replace(/\s+/g, ' ').trim().slice(0, 140)
}
