'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isDev = process.env.NODE_ENV === 'development';

  const goHome = () => {
    if (typeof window !== 'undefined') {
      window.location.href = '/';
    }
  };

  return (
    <html lang="en">
      <body
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          background: 'var(--background, #0b0d12)',
          color: 'var(--foreground, #e5e7eb)',
        }}
      >
        <div style={{ maxWidth: 560, width: '100%' }}>
          <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Application Error</div>
          <p style={{ fontSize: 14, opacity: 0.8, marginBottom: 12 }}>
            Something went wrong. {isDev ? `Error: ${error.message}` : 'Please refresh the page.'}
          </p>
          {isDev && error.digest && (
            <p style={{ fontSize: 12, opacity: 0.6, marginBottom: 12 }}>Error ID: {error.digest}</p>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => reset()}
              style={{
                padding: '8px 12px',
                borderRadius: 6,
                background: 'var(--primary, #1f2937)',
                color: 'white',
                border: 'none',
              }}
            >
              Try again
            </button>
            <button
              onClick={goHome}
              style={{
                padding: '8px 12px',
                borderRadius: 6,
                background: 'transparent',
                color: 'inherit',
                border: '1px solid rgba(255,255,255,0.2)',
              }}
            >
              Go home
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}