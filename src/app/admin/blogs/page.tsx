"use client";

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminBlogsRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin/blog');
  }, [router]);
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <p>Redirecting to Blog Management…</p>
    </div>
  );
}
