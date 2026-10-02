"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UserRow } from "./user-table-columns";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SearchX, Users } from "lucide-react";

// Constants
const ROW_HEIGHT = 60; // Height of each row in pixels
const MIN_SEARCH_LENGTH = 2;
const CONTAINER_HEIGHT = 600; // Height of the virtualized container

// Individual cell renderer for virtualized list
const UserCell = memo(({
  index,
  style,
  data
}: {
  index: number;
  style: React.CSSProperties;
  data: {
    rows: UserRow[];
    table: any;
    columns: any[];
  };
}) => {
  const { rows, table, columns } = data;
  const row = rows[index];

  if (!row) {
    return (
      <div style={style} className="flex items-center h-[60px] px-4 border-b">
        <span className="text-muted-foreground">Loading...</span>
      </div>
    );
  }

  const tableRow = table.getRowModel().rows[index];

  return (
    <div style={style} className="flex items-center border-b hover:bg-muted/50 transition-colors">
      {columns.map((column: any, cellIndex: number) => (
        <div
          key={column.id}
          className="flex-1 px-4 py-2 truncate"
          style={{ minWidth: column.getSize() }}
        >
          {column.id === 'displayName' && (
            <span className="font-medium text-foreground">{row.displayName || '—'}</span>
          )}
          {column.id === 'email' && (
            <span className="text-muted-foreground">{row.email || '—'}</span>
          )}
          {column.id === 'role' && (
            <span className="rounded bg-muted px-2 py-1 text-sm border">{row.role || 'guest'}</span>
          )}
          {column.id === 'actions' && (
            <div className="flex justify-end">
              <span className="text-xs text-muted-foreground">Actions</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
});
UserCell.displayName = "UserCell";

// Memoized header component using Uncontrolled Input for 0ms React DOM lag
const VirtualizedTableHeader = memo(({
  search,
  roleFilter,
  roleOptions,
  onSearch,
  handleRoleFilterChange,
  handleClear
}: {
  search: string;
  roleFilter: string;
  roleOptions: any[];
  onSearch: (value: string) => void;
  handleRoleFilterChange: (value: string) => void;
  handleClear: () => void;
}) => {
  // Physical Uncontrolled DOM reference
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // Micro-feedback state
  const [isTyping, setIsTyping] = useState(false);

  const onLocalClear = useCallback(() => {
    if (inputRef.current) inputRef.current.value = "";
    setIsTyping(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    handleClear();
  }, [handleClear]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    // Instant clear bypass overrides debounce
    if (val === "") {
      setIsTyping(false);
      onSearch("");
      return;
    }

    // Activate micro-spinner
    setIsTyping(true);

    // Debounce actual searches (400ms server trip wait)
    debounceRef.current = setTimeout(() => {
      setIsTyping(false); // Stop spinner explicitly before search fires
      onSearch(val);
    }, 400);
  };

  return (
    <div className="mb-6 flex flex-col sm:flex-row gap-3 items-center">
      <div className="relative flex-1 w-full flex items-center">
        <Users className="absolute left-3 h-4 w-4 text-muted-foreground z-10" />
        <Input
          ref={inputRef}
          defaultValue={search}
          placeholder={`Search by name or txt (min ${MIN_SEARCH_LENGTH} chars)`}
          onChange={handleInputChange}
          className="pl-9 pr-9 w-full bg-background/50 border-primary/20 focus:border-primary/50 transition-colors shadow-sm"
        />
        {isTyping && (
          <div className="absolute right-3 h-4 w-4 z-10 text-primary animate-spin">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
          </div>
        )}
      </div>
      <div className="flex gap-3 w-full sm:w-auto">
        <Select value={roleFilter || 'all'} onValueChange={handleRoleFilterChange}>
          <SelectTrigger className="w-[180px] bg-background/50 border-primary/20">
            <SelectValue placeholder="Filter by role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            {roleOptions.map((opt: any) => (
              <SelectItem key={opt.key} value={opt.key} className="capitalize">{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={onLocalClear} className="border-primary/20 hover:bg-primary/10">Clear</Button>
      </div>
    </div>
  );
});
VirtualizedTableHeader.displayName = "VirtualizedTableHeader";

export const VirtualizedUserTable = memo(({
  rows,
  columns,
  loading,
  search,
  roleFilter,
  roleOptions,
  onSearch,
  handleRoleFilterChange,
  handleClear,
  handleRoleChange,
  errorMessage
}: {
  rows: UserRow[];
  columns: any[];
  loading: boolean;
  search: string;
  roleFilter: string;
  roleOptions: any[];
  onSearch: (value: string) => void;
  handleRoleFilterChange: (value: string) => void;
  handleClear: () => void;
  handleRoleChange: (uid: string, newRole: string) => void;
  errorMessage?: string;
}) => {
  // Create table instance for row model
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const itemCount = rows.length;

  return (
    <Card className="border-primary/20 shadow-lg bg-background/60 backdrop-blur-sm">
      <CardHeader className="pb-4 border-b border-primary/10">
        <CardTitle className="text-xl font-bold flex items-center gap-2">
          User Database
          {loading && <div className="animate-pulse h-2 w-2 rounded-full bg-primary ml-2"></div>}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-6">
        <VirtualizedTableHeader
          search={search}
          roleFilter={roleFilter}
          roleOptions={roleOptions}
          onSearch={onSearch} // Only fires on debounce or explicit clear
          handleRoleFilterChange={handleRoleFilterChange}
          handleClear={handleClear}
        />

        {/* Sub-Agent 1 Fix: Removed the disruptive search.length < 2 barrier that wiped the DOM. Now it just shows the existing data or empty state gracefully. */}

        <div className={`rounded-lg border border-primary/10 overflow-hidden bg-background/80 shadow-inner transition-opacity duration-300 ease-in-out ${loading ? 'opacity-40 pointer-events-none' : 'opacity-100'}`}>
          {/* Table Header */}
          <div className="bg-primary/5 border-b border-primary/10">
            {table.getHeaderGroups().map((headerGroup: any) => (
              <div key={headerGroup.id} className="flex items-center h-[50px]">
                {headerGroup.headers.map((header: any) => (
                  <div
                    key={header.id}
                    className="flex-1 px-4 py-2 text-sm font-semibold text-foreground/80 tracking-wide uppercase truncate"
                    style={{ minWidth: header.column.getSize() }}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="h-[600px] overflow-auto relative custom-scrollbar">
            {loading && rows.length === 0 ? (
              <div className="h-full flex flex-col">
                {[...Array(10)].map((_, i) => (
                  <div key={i} className="flex items-center h-[60px] border-b border-primary/5 p-4 animate-pulse">
                    <div className="h-4 bg-muted rounded w-1/4 mr-auto"></div>
                    <div className="h-4 bg-muted rounded w-1/4 mx-auto"></div>
                    <div className="h-6 bg-muted rounded-full w-1/6 ml-auto"></div>
                  </div>
                ))}
              </div>
            ) : itemCount === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8 animate-in fade-in zoom-in duration-300">
                <div className="bg-primary/10 p-6 rounded-full mb-6 ring-1 ring-primary/20 shadow-inner">
                  <SearchX className="w-12 h-12 text-primary/60" />
                </div>
                <h3 className="text-2xl font-semibold mb-2 text-foreground">No Users Match Criteria</h3>
                <p className="max-w-md text-center mb-8 text-muted-foreground/80 leading-relaxed">
                  The database returned zero records for your current filters. Adjust your search term or clear the filters to view the full directory.
                </p>
                <Button onClick={handleClear} className="shadow-lg hover:shadow-primary/25 transition-all">Clear Filters & Reload</Button>
              </div>
            ) : (
              <VirtualRows rows={rows} table={table} />
            )}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground/80">
          <div>
            Showing <span className="font-semibold text-foreground">{rows.length}</span> records
            {search && ` (filtered by "${search}")`}
          </div>
          {rows.length >= 20 && (
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </span>
              Virtualized Engine Active
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
});
VirtualizedUserTable.displayName = "VirtualizedUserTable";

function VirtualRows({ rows, table }: { rows: UserRow[]; table: any }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const totalHeight = rows.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT));
  const visibleCount = Math.ceil(CONTAINER_HEIGHT / ROW_HEIGHT) + 6; // slightly larger overscan
  const endIndex = Math.min(rows.length, startIndex + visibleCount);
  const slice = useMemo(() => table.getRowModel().rows.slice(startIndex, endIndex), [table, startIndex, endIndex]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop((e.target as HTMLDivElement).scrollTop);
  }, []);

  return (
    <div ref={containerRef} onScroll={onScroll} className="h-[600px] overflow-auto relative">
      <div style={{ height: totalHeight, position: "relative" }}>
        <div style={{ position: "absolute", top: startIndex * ROW_HEIGHT, left: 0, right: 0 }}>
          {slice.map((row: any) => (
            <div key={row.id} style={{ height: ROW_HEIGHT }} className="flex items-center border-b border-primary/5 hover:bg-primary/5 transition-colors group">
              {row.getVisibleCells().map((cell: any) => (
                <div key={cell.id} className="flex-1 px-4 py-2 truncate text-sm" style={{ minWidth: cell.column.getSize() }}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}