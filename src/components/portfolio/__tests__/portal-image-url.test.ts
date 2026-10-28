import { normalizePortalImageUrl } from '@/lib/portal-image-url';

describe('normalizePortalImageUrl', () => {
  it('rewrites a Drive thumbnail URL to the direct lh3 form', () => {
    expect(
      normalizePortalImageUrl('https://drive.google.com/thumbnail?id=1Vu7FfpePgMMubN0ouHr-uOQLEGI6hIM8&sz=w1600')
    ).toBe('https://lh3.googleusercontent.com/d/1Vu7FfpePgMMubN0ouHr-uOQLEGI6hIM8=w1600');
  });

  it('rewrites a Drive file URL', () => {
    expect(
      normalizePortalImageUrl('https://drive.google.com/file/d/1KYyICfmZILs4jUFdr1_vPvHy4ssX2Adj/view?usp=sharing')
    ).toBe('https://lh3.googleusercontent.com/d/1KYyICfmZILs4jUFdr1_vPvHy4ssX2Adj=w1600');
  });

  it('rewrites a Drive open URL', () => {
    expect(normalizePortalImageUrl('https://drive.google.com/open?id=ABC-123_x')).toBe(
      'https://lh3.googleusercontent.com/d/ABC-123_x=w1600'
    );
  });

  it('leaves non-Drive URLs untouched', () => {
    const lh3 = 'https://lh3.googleusercontent.com/d/1gpSQzcmZVivKJj2a6P7pSI0KaRRaUCOb=w1600';
    expect(normalizePortalImageUrl(lh3)).toBe(lh3);
    const postimg = 'https://i.postimg.cc/85TQZFNy/image.png';
    expect(normalizePortalImageUrl(postimg)).toBe(postimg);
    const unsplash = 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?w=600&h=400&fit=crop';
    expect(normalizePortalImageUrl(unsplash)).toBe(unsplash);
  });
});
