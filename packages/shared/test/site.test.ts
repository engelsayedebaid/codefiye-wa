import { describe, expect, it } from 'vitest';
import { normalizeSiteSettings, youtubeChannelUrl, youtubeVideoId } from '../src/site';

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
    expect(normalizeSiteSettings(undefined)).toEqual({ demoVideoUrl: null, youtubeChannelUrl: null });
    expect(normalizeSiteSettings({ demoVideoUrl: 'https://youtu.be/dQw4w9WgXcQ?si=x', youtubeChannelUrl: 'https://vimeo.com/x' })).toEqual({
      demoVideoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      youtubeChannelUrl: null,
    });
  });
});
