'use client';

/**
 * /hierarchy - the public org chart of SEDS Pakistan.
 *
 * Added by founder order 2026-10-30, beside the two public community
 * surfaces that already exist (the Leaderboard on /community and the
 * Warning Registry at /warning-registry): until now the hierarchy
 * lived only in the admin console (/admin/hierarchy), so a visitor
 * could not see who leads a chapter or follow a name to a profile.
 *
 * The page renders the sanitized public feed
 * (/api/public/hierarchy): the National section first, then one
 * section per chapter (IST Chapter first), each listing the chapter's
 * officers and role-holders — name, role title, avatar — with every
 * name linking to the member's public profile. The feed carries no
 * contact data of any kind.
 *
 * Failure behaviour is truthful: a failed load shows a load-failed
 * message with a retry, never an empty chart; a successful load with
 * no published role-holders says so plainly.
 *
 * SCALABLE REDESIGN (perf program, 2026-10-30): the chart must stay
 * beautiful and fast at 20+ chapters and 500+ role-holders, not just
 * at today's 41. The mechanisms, all client-side over the one fetched
 * payload (no extra network calls, no new endpoints):
 *
 *  - Sections collapse. Collapsed sections render NO member rows, so
 *    the initial DOM stays bounded at roughly the National section
 *    plus one chapter no matter how large the society grows.
 *    Defaults: when the whole chart is small (<= 4 sections AND
 *    <= 120 people) everything starts open — zero interaction cost.
 *    Past that, National and the first chapter start open and the
 *    rest start collapsed, so the page opens as an index of chapters
 *    instead of a 500-row wall; the National layer and the flagship
 *    chapter (IST, first in feed order) are the most-visited, so they
 *    are the ones open.
 *  - Search and filters (name / role title text search, role select,
 *    chapter select) run over the already-fetched payload. While any
 *    filter is active, sections with matches render expanded — a hit
 *    is never hidden inside a collapsed section — and sections with
 *    no matches disappear; a no-match state offers a one-click reset.
 *  - Navigation aids: a chapter jump-nav (anchor chips, shown when
 *    there are more than 3 sections; selecting one also opens it) and
 *    section headers that stick below the site header while their
 *    section scrolls, so the reader always knows which chapter they
 *    are inside.
 *  - Rendering cost inside an open list is bounded with CSS
 *    content-visibility (the browser skips layout and paint for
 *    off-screen rows) and fixed-size avatars that lazy-load with an
 *    initials fallback, so a long open chapter cannot jank the page
 *    or shift its layout.
 *  - The National section is the masthead: a tinted header band and a
 *    single-column list with larger avatars. The structure itself
 *    encodes rank — the command layer reads differently from the
 *    chapters below it — instead of every section wearing the same
 *    card.
 *
 * Ordering is never re-sorted here: the feed already returns
 * sections and members in rank order, and this page renders them as
 * delivered.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Search, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { CustomRoleMarker } from '@/components/roles/custom-role-marker';
import { cn } from '@/lib/utils';
import type {
  PublicHierarchyPayload,
  PublicHierarchyPerson,
  PublicHierarchySection,
} from '@/lib/public-hierarchy';

/** Below these totals the whole chart starts open; above them it
 *  starts as a chapter index (National + first chapter open). */
const ALL_OPEN_MAX_SECTIONS = 4;
const ALL_OPEN_MAX_PEOPLE = 120;
/** The chapter jump-nav appears once the chart has more sections
 *  than a reader can hold in view at once. */
const JUMP_NAV_MIN_SECTIONS = 4;

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function PersonRow({
  person,
  masthead = false,
}: {
  person: PublicHierarchyPerson;
  masthead?: boolean;
}) {
  return (
    <li className="flex items-center gap-3 rounded-md border border-border/40 bg-background/60 px-3 py-2">
      <Avatar className={masthead ? 'size-11' : 'size-9'}>
        {person.photoURL ? (
          <AvatarImage
            src={person.photoURL}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : null}
        <AvatarFallback
          delayMs={person.photoURL ? undefined : 0}
          className={cn(
            'bg-primary/10 font-semibold text-primary',
            masthead ? 'text-sm' : 'text-xs'
          )}
        >
          {initialsOf(person.name)}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <Link
          href={person.profilePath}
          className="block truncate rounded-sm text-sm font-medium leading-snug underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {person.name}
        </Link>
      </span>
      <span className="inline-flex min-w-0 shrink items-center gap-1.5">
        <span
          title={person.roleTitle}
          className="truncate rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
        >
          {person.roleTitle}
        </span>
        {person.isCustomRole ? (
          <CustomRoleMarker className="shrink-0" />
        ) : null}
      </span>
    </li>
  );
}

function HierarchySectionView({
  section,
  open,
  filtering,
  onToggle,
}: {
  section: PublicHierarchySection;
  open: boolean;
  filtering: boolean;
  onToggle: (id: string, next: boolean) => void;
}) {
  const isNational = section.id === 'national';
  const headingId = `hierarchy-heading-${section.id}`;
  const panelId = `hierarchy-panel-${section.id}`;
  // While filtering, a section with matches is always expanded: a
  // search hit hidden behind a collapse is a failed search.
  const expanded = filtering || open;
  const countLabel = `${section.members.length} ${
    section.members.length === 1 ? 'role-holder' : 'role-holders'
  }`;

  const headerInner = (
    <>
      <span className="min-w-0 flex-1 truncate">{section.name}</span>
      <span className="shrink-0 text-sm font-normal text-muted-foreground">
        {countLabel}
      </span>
      {filtering ? null : (
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-5 shrink-0 text-muted-foreground transition-transform motion-safe:duration-200',
            expanded && 'rotate-180'
          )}
        />
      )}
    </>
  );

  return (
    <section
      id={`hierarchy-${section.id}`}
      aria-labelledby={headingId}
      className="scroll-mt-24 md:scroll-mt-28"
    >
      <Card
        className={cn(
          'bg-card/80 backdrop-blur-sm',
          isNational ? 'border-primary/40' : 'border-primary/20'
        )}
      >
        <div
          className={cn(
            'sticky top-20 z-30 rounded-t-xl border-b md:top-24',
            isNational
              ? 'border-primary/20 bg-primary/5'
              : 'border-border/40 bg-card'
          )}
        >
          <h2 id={headingId} className="text-lg font-semibold">
            {filtering ? (
              <span className="flex items-center gap-3 px-6 py-4">
                {headerInner}
              </span>
            ) : (
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => onToggle(section.id, !expanded)}
                className="flex w-full items-center gap-3 rounded-t-xl px-6 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {headerInner}
              </button>
            )}
          </h2>
        </div>
        {expanded ? (
          <div id={panelId} role="region" aria-labelledby={headingId}>
            <CardContent className="pt-6">
              <ul
                className={cn(
                  'grid gap-2 [content-visibility:auto] [contain-intrinsic-size:auto_320px]',
                  isNational ? 'grid-cols-1' : 'sm:grid-cols-2'
                )}
              >
                {section.members.map((person) => (
                  <PersonRow
                    key={`${person.id}-${person.roleTitle}`}
                    person={person}
                    masthead={isNational}
                  />
                ))}
              </ul>
            </CardContent>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

function LoadingChart() {
  return (
    <div aria-busy="true" className="space-y-8">
      <span className="sr-only" role="status">
        Loading the hierarchy.
      </span>
      {[0, 1].map((card) => (
        <Card
          key={card}
          className="border-primary/20 bg-card/80 backdrop-blur-sm"
        >
          <CardContent className="space-y-3 pt-6">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-2/3" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

const selectClassName =
  'flex h-9 w-full appearance-none items-center rounded-md border border-input bg-background px-3 py-1 pr-9 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

export default function HierarchyPage() {
  const [data, setData] = useState<PublicHierarchyPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [chapterFilter, setChapterFilter] = useState('all');
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>(
    {}
  );

  const load = useCallback(async (signal: { cancelled: boolean }) => {
    try {
      const res = await fetch('/api/public/hierarchy');
      if (!res.ok) throw new Error('hierarchy feed failed');
      const json = (await res.json()) as PublicHierarchyPayload;
      if (!signal.cancelled) {
        setData(json);
        setFailed(false);
      }
    } catch {
      if (!signal.cancelled) setFailed(true);
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load, reloadKey]);

  const sections = data?.sections ?? null;
  const totalPeople = useMemo(
    () =>
      sections?.reduce((n, section) => n + section.members.length, 0) ?? 0,
    [sections]
  );

  /** Sections that start open before the reader touches anything. */
  const defaultOpen = useMemo(() => {
    const open = new Set<string>();
    if (!sections) return open;
    if (
      sections.length <= ALL_OPEN_MAX_SECTIONS &&
      totalPeople <= ALL_OPEN_MAX_PEOPLE
    ) {
      sections.forEach((s) => open.add(s.id));
    } else {
      // National first, then the flagship chapter: feed order.
      sections.slice(0, 2).forEach((s) => open.add(s.id));
    }
    return open;
  }, [sections, totalPeople]);

  const roleOptions = useMemo(() => {
    const counts = new Map<string, number>();
    sections?.forEach((s) =>
      s.members.forEach((m) =>
        counts.set(m.roleTitle, (counts.get(m.roleTitle) ?? 0) + 1)
      )
    );
    return [...counts.entries()]
      .map(([title, count]) => ({ title, count }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [sections]);

  const filtering =
    query.trim() !== '' || roleFilter !== 'all' || chapterFilter !== 'all';

  const visibleSections = useMemo(() => {
    if (!sections) return [];
    const q = query.trim().toLowerCase();
    return sections
      .filter((s) => chapterFilter === 'all' || s.id === chapterFilter)
      .map((s) => ({
        ...s,
        members: s.members.filter((m) => {
          if (roleFilter !== 'all' && m.roleTitle !== roleFilter) {
            return false;
          }
          if (
            q &&
            !m.name.toLowerCase().includes(q) &&
            !m.roleTitle.toLowerCase().includes(q)
          ) {
            return false;
          }
          return true;
        }),
      }))
      .filter((s) => s.members.length > 0);
  }, [sections, query, roleFilter, chapterFilter]);

  const visiblePeople = useMemo(
    () => visibleSections.reduce((n, s) => n + s.members.length, 0),
    [visibleSections]
  );

  const setOpen = useCallback((id: string, next: boolean) => {
    setOpenOverrides((prev) => ({ ...prev, [id]: next }));
  }, []);

  const setAllOpen = useCallback(
    (next: boolean) => {
      if (!sections) return;
      setOpenOverrides((prev) => {
        const merged = { ...prev };
        sections.forEach((s) => {
          merged[s.id] = next;
        });
        return merged;
      });
    },
    [sections]
  );

  const clearFilters = useCallback(() => {
    setQuery('');
    setRoleFilter('all');
    setChapterFilter('all');
  }, []);

  return (
    <div className="container mx-auto max-w-6xl px-4 py-10">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Hierarchy</h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Who leads SEDS Pakistan, chapter by chapter: the national
          officers, and each chapter&apos;s president, officers and
          role-holders. Select a name to open that member&apos;s public
          profile.
        </p>
        {sections && totalPeople > 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {totalPeople}{' '}
            {totalPeople === 1 ? 'role-holder' : 'role-holders'} across{' '}
            {sections.length} {sections.length === 1 ? 'section' : 'sections'}
          </p>
        ) : null}
      </div>

      {failed ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">
              The hierarchy could not be loaded. This is a loading
              problem, not an empty chart.
            </p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => {
                setFailed(false);
                setData(null);
                setReloadKey((k) => k + 1);
              }}
            >
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : sections === null ? (
        <LoadingChart />
      ) : sections.length === 0 || totalPeople === 0 ? (
        <Card>
          <CardContent className="py-8">
            <p className="text-muted-foreground">
              No role-holders are published yet. Chapter officers will
              appear here as they are appointed.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="mb-6 flex flex-col gap-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <div className="min-w-0 flex-1" role="search">
                <Label htmlFor="hierarchy-search" className="sr-only">
                  Search by name or role
                </Label>
                <div className="relative">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    id="hierarchy-search"
                    type="search"
                    autoComplete="off"
                    placeholder="Search by name or role"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden"
                  />
                  {query ? (
                    <button
                      type="button"
                      aria-label="Clear search"
                      onClick={() => setQuery('')}
                      className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X aria-hidden="true" className="size-4" />
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="relative">
                  <Label htmlFor="hierarchy-role-filter" className="sr-only">
                    Filter by role
                  </Label>
                  <select
                    id="hierarchy-role-filter"
                    value={roleFilter}
                    onChange={(e) => setRoleFilter(e.target.value)}
                    className={cn(selectClassName, 'sm:w-60')}
                  >
                    <option value="all">All roles</option>
                    {roleOptions.map((r) => (
                      <option key={r.title} value={r.title}>
                        {r.title} ({r.count})
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    aria-hidden="true"
                    className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                </div>
                <div className="relative">
                  <Label htmlFor="hierarchy-chapter-filter" className="sr-only">
                    Filter by chapter
                  </Label>
                  <select
                    id="hierarchy-chapter-filter"
                    value={chapterFilter}
                    onChange={(e) => setChapterFilter(e.target.value)}
                    className={cn(selectClassName, 'sm:w-52')}
                  >
                    <option value="all">All chapters</option>
                    {sections.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.members.length})
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    aria-hidden="true"
                    className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setAllOpen(true)}
                  >
                    Expand all
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setAllOpen(false)}
                  >
                    Collapse all
                  </Button>
                </div>
              </div>
            </div>
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {filtering
                ? `Showing ${visiblePeople} of ${totalPeople} role-holders`
                : 'Search, filter, or jump to a chapter to find a role-holder.'}
            </p>
          </div>

          {sections.length >= JUMP_NAV_MIN_SECTIONS ? (
            <nav aria-label="Chapters" className="mb-6">
              <ul className="flex gap-2 overflow-x-auto pb-1">
                {(filtering ? visibleSections : sections).map((s) => (
                  <li key={s.id} className="shrink-0">
                    <a
                      href={`#hierarchy-${s.id}`}
                      onClick={() => setOpen(s.id, true)}
                      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background/60 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-ring"
                    >
                      {s.name}
                      <span className="text-xs text-muted-foreground">
                        {s.members.length}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}

          {visibleSections.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-muted-foreground">
                  No one matches that search. Try a different name or
                  role, or clear the search and filters.
                </p>
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={clearFilters}
                >
                  Clear search and filters
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-8">
              {visibleSections.map((section) => (
                <HierarchySectionView
                  key={section.id}
                  section={section}
                  open={
                    openOverrides[section.id] ?? defaultOpen.has(section.id)
                  }
                  filtering={filtering}
                  onToggle={setOpen}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
