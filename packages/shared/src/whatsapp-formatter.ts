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
  let cleaned = text;

  // Remove Markdown headings (#, ##, ### at line start)
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');

  // Convert **bold** to *bold* only for genuine emphasis
  // First, convert ** to * (but be careful not to over-convert)
  cleaned = cleaned.replace(/\*\*(.+?)\*\*/g, (match, content) => {
    // Only convert if it's a short phrase (genuine emphasis)
    if (content.length <= 50 && !content.includes('\n')) {
      return `*${content}*`;
    }
    // Otherwise, just remove the asterisks
    return content;
  });

  // Remove remaining ** markers
  cleaned = cleaned.replace(/\*\*/g, '');

  // Remove __bold__ (alternative Markdown)
  cleaned = cleaned.replace(/__(.+?)__/g, '$1');

  // Remove _italic_ (keep it simple)
  cleaned = cleaned.replace(/_(.+?)_/g, '$1');

  // Remove `code` backticks but preserve the content
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

  // Remove ```code blocks``` but preserve content
  cleaned = cleaned.replace(/```[\s\S]*?```/g, (match) => {
    return match.replace(/```/g, '').trim();
  });

  // Remove strikethrough ~~text~~
  cleaned = cleaned.replace(/~~(.+?)~~/g, '$1');

  // Remove excessive asterisks (more than 2 in a row)
  cleaned = cleaned.replace(/\*{3,}/g, '');

  // Remove bullet points with *, -, or + (replace with plain text or remove)
  cleaned = cleaned.replace(/^[\s]*[-*+]\s+/gm, '• ');

  // Remove numbered list markers but keep the numbers
  cleaned = cleaned.replace(/^[\s]*\d+\.\s+/gm, (match) => {
    const num = match.match(/\d+/)?.[0] || '';
    return `${num}. `;
  });

  // Remove blockquotes >
  cleaned = cleaned.replace(/^>\s+/gm, '');

  // Remove horizontal rules ---, ***
  cleaned = cleaned.replace(/^[-*_]{3,}\s*$/gm, '');

  // Remove excessive line breaks (more than 2 consecutive)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // Trim whitespace
  cleaned = cleaned.trim();

  // Remove excessive emojis (more than 2 in a row)
  cleaned = cleaned.replace(/([^\p{Emoji_Presentation}\s])\p{Emoji_Presentation}{3,}/gu, '$1');

  // Remove decorative characters at line start
  cleaned = cleaned.replace(/^[\s*•\-–—]+\s*/gm, '');

  return cleaned;
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
