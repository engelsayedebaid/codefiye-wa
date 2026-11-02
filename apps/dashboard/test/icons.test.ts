import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as icons from '../src/icons';
import { FuiMagnifyingGlass, FuiMessage, FuiMessagesFilled } from '../src/icons/frosted';

const render = (icon: icons.LucideIcon, props: icons.LucideProps = {}) => renderToStaticMarkup(createElement(icon, props));

describe('icons', () => {
  it('renders every icon the dashboard imports', () => {
    const names = Object.keys(icons).filter((name) => !['LucideProvider', 'filledIcon'].includes(name));
    expect(names.length).toBeGreaterThan(150);
    for (const name of names) {
      const markup = render((icons as unknown as Record<string, icons.LucideIcon>)[name]!);
      // Frosted glyphs keep their 20px grid; lucide ones are 24px.
      expect(markup, name).toMatch(/^<svg[^>]*viewBox="0 0 (20 20|24 24)"/);
      expect(markup, name).toMatch(/<(path|circle|rect|line|polyline|polygon|ellipse)\b/);
    }
  });

  it('draws Frosted glyphs as filled, unstroked shapes on a 20px grid', () => {
    const search = render(FuiMagnifyingGlass, { className: 'size-4' });
    expect(search).toContain('viewBox="0 0 20 20"');
    expect(search).toMatch(/fill="currentColor"[^>]*stroke="none"|stroke="none"[^>]*fill="currentColor"/);
    expect(search).toContain('size-4');
  });

  it('keeps the lucide fallbacks on the provider line, and an explicit width still wins', () => {
    const provided = renderToStaticMarkup(createElement(icons.LucideProvider, { strokeWidth: 1.5 }, createElement(icons.KeyRound)));
    expect(provided).toContain('stroke-width="1.5"');
    expect(render(icons.Check, { strokeWidth: 3 })).toContain('stroke-width="3"');
  });

  it('maps the names the call sites use onto Frosted where it has the icon', () => {
    expect(render(icons.Search)).toBe(render(FuiMagnifyingGlass));
    expect(render(icons.MessageSquareText)).toBe(render(FuiMessage));
  });

  it("gives sidebar icons their solid twin for the open page, and leaves the rest as they are", () => {
    expect(icons.filledIcon(icons.MessagesSquare)).toBe(FuiMessagesFilled);
    expect(icons.filledIcon(icons.KeyRound)).toBe(icons.KeyRound);
  });
});
