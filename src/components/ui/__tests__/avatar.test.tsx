/**
 * T2-4 Job 1 (avatar CORS) — lead-side implementation of teammate 2's
 * verified spec (his commit 4e982751 on fix/atika-profile-display; his
 * attachment-format diff does not extract from chat, so the fix is applied
 * here from his delivery text and gated on this fresh install).
 *
 * Root cause: AvatarImage defaulted crossOrigin='anonymous'. CORS-mode
 * loads require Access-Control-Allow-Origin; Google a-/ profile-photo URLs
 * do not reliably send it, so avatars hard-failed where a plain <img>
 * loads fine. Fix: no crossOrigin default; referrerPolicy stays.
 */
import React from 'react';

// Radix Avatar.Image only mounts its <img> after a real image load, which
// jsdom never fires; the defect surface is the props OUR component passes
// to the primitive, so the primitive is mocked to a plain <img> that
// spreads every prop it receives onto the DOM node.
jest.mock('@radix-ui/react-avatar', () => {
  const ReactMock = require('react');
  return {
    Root: ReactMock.forwardRef(({ children, ...props }: any, ref: any) => (
      <div ref={ref} {...props}>{children}</div>
    )),
    Image: ReactMock.forwardRef((props: any, ref: any) => <img ref={ref} {...props} />),
    Fallback: ReactMock.forwardRef(({ children, ...props }: any, ref: any) => (
      <div ref={ref} {...props}>{children}</div>
    )),
  };
});
import { render } from '@testing-library/react';
import { Avatar, AvatarImage } from '../avatar';

const GOOGLE_PHOTO = 'https://lh3.googleusercontent.com/a/ACg8ocLS-6aD2--WlhzI_od19PgXMGmc7DbdyAuvPX7o4pLMDnqZsYI=s96-c';

function renderAvatar(props: Record<string, unknown> = {}) {
  const { container } = render(
    <Avatar>
      <AvatarImage src={GOOGLE_PHOTO} alt="Atika Saroosh" {...props} />
    </Avatar>,
  );
  return container.querySelector('img');
}

describe('AvatarImage CORS defaults (T2-4)', () => {
  it('renders no crossorigin attribute by default on a Google photo URL', () => {
    const img = renderAvatar();
    expect(img).not.toBeNull();
    expect(img!.getAttribute('crossorigin')).toBeNull();
  });

  it('keeps the no-referrer referrerPolicy default', () => {
    const img = renderAvatar();
    expect(img!.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('honours an explicit crossOrigin="anonymous" opt-in', () => {
    const img = renderAvatar({ crossOrigin: 'anonymous' });
    expect(img!.getAttribute('crossorigin')).toBe('anonymous');
  });

  it('honours a caller referrerPolicy override', () => {
    const img = renderAvatar({ referrerPolicy: 'origin' });
    expect(img!.getAttribute('referrerpolicy')).toBe('origin');
  });
});
