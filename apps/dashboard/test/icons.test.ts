import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as icons from '../src/icons';
import { IconlyChat, IconlySearch } from '../src/icons/iconly';

const render = (icon: icons.LucideIcon, props: icons.LucideProps = {}) => renderToStaticMarkup(createElement(icon, props));

describe('icons', () => {
  it('renders every icon the dashboard imports', () => {
    const names = Object.keys(icons).filter((name) => !['LucideProvider'].includes(name));
    expect(names.length).toBeGreaterThan(150);
    for (const name of names) {
      const markup = render((icons as unknown as Record<string, icons.LucideIcon>)[name]!);
      expect(markup, name).toMatch(/^<svg[^>]*viewBox="0 0 24 24"/);
      // A shape, not just an empty group: lucide draws only top-level nodes.
      expect(markup, name).toMatch(/<(path|circle|rect|line|polyline|polygon|ellipse)\b/);
    }
  });

  it('draws Iconly with the 1.5px line from the provider, and an explicit width still wins', () => {
    const provided = renderToStaticMarkup(createElement(icons.LucideProvider, { strokeWidth: 1.5 }, createElement(IconlySearch)));
    expect(provided).toContain('stroke-width="1.5"');
    expect(render(IconlySearch, { strokeWidth: 3 })).toContain('stroke-width="3"');
  });

  it('flattens Iconly groups into their shapes and leaves its filled shapes unstroked', () => {
    const chat = render(IconlyChat, { className: 'size-4' });
    expect(chat).not.toContain('<g');
    // The group's offset comes first, then the shape's own.
    expect(chat).toContain('transform="translate(2 2) translate(4.527 9.056)"');
    // The three dots inside the bubble are filled, not outlined.
    expect(chat).toMatch(/fill="currentColor"[^>]*stroke="none"|stroke="none"[^>]*fill="currentColor"/);
    expect(chat).toContain('size-4');
  });

  it('maps the names the call sites use onto Iconly where it has the icon', () => {
    expect(icons.Trash2).toBe(icons.Trash2);
    expect(render(icons.MessageSquareText)).toBe(render(IconlyChat));
    expect(render(icons.Search)).toBe(render(IconlySearch));
  });
});
