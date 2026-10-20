/**
 * WhatsApp message formatter for AI-generated responses.
 * Converts Markdown and other formatting to WhatsApp-compatible plain text.
 */

/**
 * Cleans AI-generated text to be WhatsApp-friendly.
 * - Removes Markdown headings (#, ##, ###)
 * - Converts **bold** to *bold* sparingly
 * - Removes excessive asterisks and formatting
 * - Preserves meaningful line breaks and paragraphs
 * - Handles URLs, numbered lists, and special characters
 */
export function formatForWhatsApp(text: string): string {
  let cleaned = text.replace(/\r\n?/g, '\n');

  // Code first: its content must not be read as Markdown. ```blocks``` before `inline`.
  cleaned = cleaned.replace(/```(?:[\w+-]*\n)?([\s\S]*?)```/g, (_match, content: string) => content.trim());
  cleaned = cleaned.replace(/`([^`\n]+)`/g, '$1');

  // Headings, blockquotes and horizontal rules (a whole line of ---, *** or ___).
  cleaned = cleaned.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  cleaned = cleaned.replace(/^[ \t]*>[ \t]?/gm, '');
  cleaned = cleaned.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '');

  // [label](url) → the address WhatsApp can open.
  cleaned = cleaned.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label: string, url: string) =>
    label.trim() === url ? url : `${label.trim()}: ${url}`,
  );

  // Runs of three or more asterisks (***text***) are decoration, not emphasis.
  cleaned = cleaned.replace(/\*{3,}/g, '');

  // List markers become "• " (before bold, so "* item" is not read as emphasis).
  cleaned = cleaned.replace(/^[ \t]*[-*+][ \t]+/gm, '• ');
  cleaned = cleaned.replace(/^[ \t]*(\d+)[.)][ \t]+/gm, '$1. ');

  // **bold** → WhatsApp's *bold* for a short phrase; a long one loses the markers.
  cleaned = cleaned.replace(/\*\*([^*\n]+?)\*\*/g, (_match, content: string) =>
    content.length <= 50 ? `*${content}*` : content,
  );
  cleaned = cleaned.replace(/\*\*/g, '');

  // __bold__ and _italic_ only around whole words: an underscore inside a name, an e-mail or a
  // link (my_shop, https://x.com/a_b) stays.
  cleaned = cleaned.replace(/(^|[\s(])__([^_\n]+?)__(?=$|[\s).,!?،؛:])/gm, '$1$2');
  cleaned = cleaned.replace(/(^|[\s(])_([^_\n]+?)_(?=$|[\s).,!?،؛:])/gm, '$1$2');

  // ~~strikethrough~~
  cleaned = cleaned.replace(/~~([^~\n]+?)~~/g, '$1');

  // At most two emoji in a row.
  cleaned = cleaned.replace(/(\p{Extended_Pictographic}️?){3,}/gu, (run: string) =>
    (run.match(/\p{Extended_Pictographic}️?/gu) ?? []).slice(0, 2).join(''),
  );

  // Trailing spaces, then at most one blank line between paragraphs.
  cleaned = cleaned.replace(/[ \t]+$/gm, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

/**
 * Detects if text contains Markdown formatting that needs cleaning.
 */
export function hasMarkdownFormatting(text: string): boolean {
  return /#{1,6}\s+|\*\*.+?\*\*|`[^`]+`|```[\s\S]*?```|~~.+?~~/.test(text);
}

/**
 * Preserves URLs while cleaning other formatting.
 */
export function cleanButPreserveUrls(text: string): string {
  const urlRegex = /(https?:\/\/[^\s<]+)/g;
  const urls: string[] = [];
  let match;

  // Extract URLs
  while ((match = urlRegex.exec(text)) !== null) {
    urls.push(match[0]);
  }

  // Clean the text
  const cleaned = formatForWhatsApp(text);

  // Restore URLs (in case they were affected)
  let result = cleaned;
  urls.forEach((url) => {
    if (!result.includes(url)) {
      result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, (match, label) => {
        return label === url ? url : match;
      });
    }
  });

  return result;
}
