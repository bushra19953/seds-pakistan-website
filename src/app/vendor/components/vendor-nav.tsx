'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/vendor', label: 'Home' },
  { href: '/vendor/products', label: 'Products' },
  { href: '/vendor/orders', label: 'Orders' },
  { href: '/vendor/sales', label: 'Sales' },
  { href: '/vendor/balance', label: 'Balance' },
];

export function VendorNav({ businessName }: { businessName: string | null }) {
  const pathname = usePathname();
  return (
    <header className="border-b">
      <div className="container px-4 md:px-6 py-3 flex items-center gap-4 flex-wrap">
        <span className="font-bold">Vendor</span>
        <nav className="flex items-center gap-1 flex-wrap">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`px-3 py-1.5 rounded-md text-sm ${
                pathname === l.href ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        {businessName && <span className="ml-auto text-sm text-muted-foreground">{businessName}</span>}
      </div>
    </header>
  );
}
