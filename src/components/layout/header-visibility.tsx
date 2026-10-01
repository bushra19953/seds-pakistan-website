"use client";

import { usePathname } from "next/navigation";
import Header from "@/components/layout/header";

export default function HeaderVisibility() {
  const pathname = usePathname();
  const hideOnAdmin = pathname?.startsWith("/admin");
  if (hideOnAdmin) return null;
  return <Header />;
}