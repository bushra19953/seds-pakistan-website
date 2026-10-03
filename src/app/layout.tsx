import type { Metadata, Viewport } from 'next';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0a0a0f',
};
// Load brand fonts via next/font and expose them as CSS variables
import { Bebas_Neue, Courier_Prime, Orbitron } from 'next/font/google';
// Configure Google Fonts using Next.js font loader for optimal performance.
// We assign CSS variables so Tailwind can reference them in utility classes.
const bebas = Bebas_Neue({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  variable: '--font-bebas-neue',
});
const courier = Courier_Prime({
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
  variable: '--font-courier-prime',
});
const orbitron = Orbitron({
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
  variable: '--font-orbitron',
});
// Moved to dynamic import in AppClientShell to avoid loading VantaBackground on admin routes
import AppClientShell from '@/components/layout/app-client-shell';

export const metadata: Metadata = {
  title: {
    default: 'SEDS Pakistan Digital Hub',
    template: '%s | SEDS Pakistan'
  },
  description: 'The digital hub for Students for the Exploration and Development of Space (SEDS) in Pakistan. Join us in advancing space science and technology education.',
  keywords: 'SEDS, space, astronomy, Pakistan, education, technology, rocketry, satellite, astronautics, STEM',
  authors: [{ name: 'SEDS Pakistan' }],
  creator: 'SEDS Pakistan',
  publisher: 'SEDS Pakistan',
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    }
  },
  alternates: {
    canonical: 'https://seds-pakistan.vercel.app'
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://seds-pakistan.vercel.app',
    title: 'SEDS Pakistan Digital Hub',
    description: 'The digital hub for Students for the Exploration and Development of Space (SEDS) in Pakistan. Join us in advancing space science and technology education.',
    siteName: 'SEDS Pakistan',
    images: [
      {
        url: 'https://seds-pakistan.vercel.app/images/og-image.jpg',
        width: 1200,
        height: 630,
        alt: 'SEDS Pakistan - Students for the Exploration and Development of Space'
      }
    ]
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SEDS Pakistan Digital Hub',
    description: 'The digital hub for Students for the Exploration and Development of Space (SEDS) in Pakistan.',
    images: ['https://seds-pakistan.vercel.app/images/og-image.jpg'],
    creator: '@SEDSPakistan'
  },
  verification: {
    google: 'your-google-verification-code'
  }
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${bebas.variable} ${courier.variable} ${orbitron.variable}`}>
      <head>
        {/* Optimized single preconnect to primary Firestore origin */}
        <link rel="preconnect" href="https://firestore.googleapis.com" />
        <link rel="dns-prefetch" href="https://firestore.googleapis.com" />
        <link rel="dns-prefetch" href="https://apis.google.com" />
      </head>
      <body className="font-body antialiased overflow-x-hidden" style={{ touchAction: 'pan-y' }}>
        <AppClientShell>
          {children}
        </AppClientShell>
      </body>
    </html>
  );
}
