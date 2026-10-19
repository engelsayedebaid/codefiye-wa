import { describe, expect, it } from 'vitest';
import { formatForWhatsApp, hasMarkdownFormatting, cleanButPreserveUrls } from '../src/whatsapp-formatter';

describe('WhatsApp Message Formatter', () => {
  describe('formatForWhatsApp', () => {
    it('removes Markdown headings', () => {
      expect(formatForWhatsApp('# Heading')).toBe('Heading');
      expect(formatForWhatsApp('## Subheading')).toBe('Subheading');
      expect(formatForWhatsApp('### Subsubheading')).toBe('Subsubheading');
    });

    it('converts **bold** to *bold* for short phrases', () => {
      expect(formatForWhatsApp('This is **important**')).toBe('This is *important*');
      expect(formatForWhatsApp('**price** is 500')).toBe('*price* is 500');
    });

    it('removes **bold** for long phrases', () => {
      const longText = 'This is a very long text that should not be converted to bold formatting because it is not genuine emphasis but rather a long paragraph that should remain as plain text without any special formatting applied to it';
      expect(formatForWhatsApp(`**${longText}**`)).toBe(longText);
    });

    it('removes remaining ** markers', () => {
      expect(formatForWhatsApp('text**')).toBe('text');
      expect(formatForWhatsApp('**text')).toBe('text');
    });

    it('removes __bold__ alternative', () => {
      expect(formatForWhatsApp('__bold__')).toBe('bold');
    });

    it('removes _italic_', () => {
      expect(formatForWhatsApp('_italic_')).toBe('italic');
    });

    it('removes `code` backticks', () => {
      expect(formatForWhatsApp('Use `npm install`')).toBe('Use npm install');
    });

    it('removes code blocks', () => {
      expect(formatForWhatsApp('```const x = 1```')).toBe('const x = 1');
    });

    it('removes strikethrough', () => {
      expect(formatForWhatsApp('~~deleted~~')).toBe('deleted');
    });

    it('removes excessive asterisks', () => {
      expect(formatForWhatsApp('***text***')).toBe('text');
      expect(formatForWhatsApp('****text****')).toBe('text');
    });

    it('converts bullet points to •', () => {
      expect(formatForWhatsApp('- item')).toBe('• item');
      expect(formatForWhatsApp('* item')).toBe('• item');
      expect(formatForWhatsApp('+ item')).toBe('• item');
    });

    it('preserves numbered lists', () => {
      expect(formatForWhatsApp('1. First')).toBe('1. First');
      expect(formatForWhatsApp('2. Second')).toBe('2. Second');
    });

    it('removes blockquotes', () => {
      expect(formatForWhatsApp('> quote')).toBe('quote');
    });

    it('removes horizontal rules', () => {
      expect(formatForWhatsApp('---')).toBe('');
      expect(formatForWhatsApp('***')).toBe('');
    });

    it('removes excessive line breaks', () => {
      expect(formatForWhatsApp('text\n\n\n\ntext')).toBe('text\n\ntext');
    });

    it('trims whitespace', () => {
      expect(formatForWhatsApp('  text  ')).toBe('text');
    });

    it('handles Arabic text with Markdown', () => {
      expect(formatForWhatsApp('# العنوان')).toBe('العنوان');
      expect(formatForWhatsApp('**مهم** جداً')).toBe('*مهم* جداً');
    });

    it('handles mixed Arabic and English', () => {
      expect(formatForWhatsApp('Hello **مرحبا** world')).toBe('Hello *مرحبا* world');
    });

    it('preserves URLs', () => {
      const text = 'Visit https://example.com for more info';
      expect(formatForWhatsApp(text)).toBe(text);
    });

    it('handles multiline messages', () => {
      const text = 'First paragraph\n\nSecond paragraph\n\nThird paragraph';
      const result = formatForWhatsApp(text);
      expect(result).toContain('First paragraph');
      expect(result).toContain('Second paragraph');
      expect(result).toContain('Third paragraph');
    });

    it('removes decorative characters at line start', () => {
      expect(formatForWhatsApp('*   text')).toBe('text');
      expect(formatForWhatsApp('-   text')).toBe('text');
    });

    it('handles complex mixed formatting', () => {
      const input = `# Welcome

## Services
- Web Development
- Mobile Apps

**Important**: Visit https://codefiye.com

\`\`\`npm install\`\`\`

~~old price~~: $500`;
      const result = formatForWhatsApp(input);
      expect(result).not.toContain('#');
      expect(result).not.toContain('##');
      expect(result).not.toContain('**');
      expect(result).not.toContain('```');
      expect(result).not.toContain('~~');
      expect(result).toContain('https://codefiye.com');
    });
  });

  describe('hasMarkdownFormatting', () => {
    it('detects headings', () => {
      expect(hasMarkdownFormatting('# Heading')).toBe(true);
      expect(hasMarkdownFormatting('## Heading')).toBe(true);
    });

    it('detects bold', () => {
      expect(hasMarkdownFormatting('**bold**')).toBe(true);
    });

    it('detects code', () => {
      expect(hasMarkdownFormatting('`code`')).toBe(true);
      expect(hasMarkdownFormatting('```code```')).toBe(true);
    });

    it('detects strikethrough', () => {
      expect(hasMarkdownFormatting('~~text~~')).toBe(true);
    });

    it('returns false for plain text', () => {
      expect(hasMarkdownFormatting('plain text')).toBe(false);
    });
  });

  describe('cleanButPreserveUrls', () => {
    it('preserves URLs while cleaning other formatting', () => {
      const input = 'Visit **https://example.com** for info';
      const result = cleanButPreserveUrls(input);
      expect(result).toContain('https://example.com');
      expect(result).not.toContain('**');
    });

    it('preserves markdown links', () => {
      const input = '[link](https://example.com)';
      const result = cleanButPreserveUrls(input);
      expect(result).toContain('https://example.com');
    });

    it('handles multiple URLs', () => {
      const input = 'Visit https://example.com and https://test.com';
      const result = cleanButPreserveUrls(input);
      expect(result).toContain('https://example.com');
      expect(result).toContain('https://test.com');
    });
  });
});
