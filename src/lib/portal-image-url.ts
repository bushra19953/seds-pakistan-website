// Drive thumbnail/file links 302-redirect to lh3.googleusercontent.com
// WITHOUT a CORS header on the redirect itself, so browsers refuse them
// as WebGL textures (crossOrigin loads require the header on every
// response in the chain) even though the same link renders fine in a
// plain <img>. Rewrite any Google Drive share/thumbnail URL to the
// direct lh3 form, which serves Access-Control-Allow-Origin: *, before
// it reaches the texture loader. Non-Drive URLs pass through untouched.
export function normalizePortalImageUrl(url: string): string {
  if (typeof url !== 'string') return url;
  const patterns = [
    /drive\.google\.com\/thumbnail\?[^#]*\bid=([\w-]+)/,
    /drive\.google\.com\/file\/d\/([\w-]+)/,
    /drive\.google\.com\/(?:open|uc)\?[^#]*\bid=([\w-]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return `https://lh3.googleusercontent.com/d/${match[1]}=w1600`;
  }
  return url;
}
