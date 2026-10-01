"use client";

import React from "react";
import { cn } from "@/lib/utils";

interface ResponsiveTableProps {
  table: React.ReactNode;
  cards: React.ReactNode;
  className?: string;
}

export function ResponsiveTable({ table, cards, className }: ResponsiveTableProps) {
  return (
    <div className={cn("w-full", className)}>
      <div className="hidden md:block">{table}</div>
      <div className="block md:hidden">{cards}</div>
    </div>
  );
}

export default ResponsiveTable;

