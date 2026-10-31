import { describe, expect, it } from 'vitest';
import { normalizeSiteSettings, phoneHref, sitePhone, youtubeChannelUrl, youtubeVideoId } from '../src/site';

describe('YouTube links', () => {
  it('finds the video id in every common link shape', () => {
    for (const link of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123',
      'http://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
      'youtu.be/dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
      '  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ',
    ]) {
      expect(youtubeVideoId(link), link).toBe('dQw4w9WgXcQ');
    }
  });

  it('refuses links that are not YouTube videos', () => {
    for (const link of [
      '',
      'dQw4w9WgXcQ',
      'https://vimeo.com/123456',
      'https://www.youtube.com/@codefiye',
      'https://www.youtube.com/watch?v=short',
      'https://evil.example/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'javascript:alert(1)//youtu.be/dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ extra',
    ]) {
      expect(youtubeVideoId(link), link).toBeNull();
    }
  });

  it('makes channel, handle and playlist links canonical', () => {
    expect(youtubeChannelUrl('@codefiye')).toBe('https://www.youtube.com/@codefiye');
    expect(youtubeChannelUrl('youtube.com/@codefiye/')).toBe('https://www.youtube.com/@codefiye');
    expect(youtubeChannelUrl('https://m.youtube.com/channel/UC1234567890123456789012')).toBe('https://www.youtube.com/channel/UC1234567890123456789012');
    expect(youtubeChannelUrl('https://www.youtube.com/playlist?list=PL123')).toBe('https://www.youtube.com/playlist?list=PL123');
    expect(youtubeChannelUrl('https://www.youtube.com/')).toBeNull();
    expect(youtubeChannelUrl('https://example.com/@codefiye')).toBeNull();
    expect(youtubeChannelUrl('javascript:alert(1)')).toBeNull();
  });

  it('keeps only valid links when reading the stored settings', () => {
    expect(normalizeSiteSettings(undefined)).toEqual({ demoVideoUrl: null, youtubeChannelUrl: null, address: null, addressEn: null, phone: null });
    expect(normalizeSiteSettings({ demoVideoUrl: 'https://youtu.be/dQw4w9WgXcQ?si=x', youtubeChannelUrl: 'https://vimeo.com/x' })).toEqual({
      demoVideoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      youtubeChannelUrl: null,
      address: null,
      addressEn: null,
      phone: null,
    });
  });

  it('keeps the contact details on one line and drops a malformed phone', () => {
    const site = normalizeSiteSettings({ address: '  12 شارع التحرير،\n الدقي، الجيزة ', addressEn: '', phone: 'call me' });
    expect(site).toMatchObject({ address: '12 شارع التحرير، الدقي، الجيزة', addressEn: null, phone: null });
  });
});

describe('contact phone', () => {
  it('accepts the shapes Egyptian numbers are written in', () => {
    expect(sitePhone(' +20 2  3333 4444 ')).toBe('+20 2 3333 4444');
    expect(sitePhone('010-1234-5678')).toBe('010-1234-5678');
    expect(sitePhone('19555')).toBe('19555');
    for (const bad of ['', '123', '+20 abc', '1234567890123456', '+20+2']) expect(sitePhone(bad), bad).toBeNull();
  });

  it('links to the digits only', () => {
    expect(phoneHref('+20 (2) 3333-4444')).toBe('tel:+20233334444');
    expect(phoneHref('010 1234 5678')).toBe('tel:01012345678');
  });
});
