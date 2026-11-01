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
 * VISUAL ORG CHART (founder design correction, 2026-10-30): the
 * chart is a top-down tree, not a list of rows — the top office at
 * the apex, branches descending with visible connector lines, people
 * as node cards (avatar, name, role title), each level under its
 * parent. A Chart / List toggle keeps the section list one tap away:
 * it is the text alternative for screen readers (the tree itself is
 * built from real nested lists, so its structure is navigable either
 * way) and the denser view for finding a name fast.
 *
 * EDGES ARE ONLY WHAT THE DATA SUPPORTS. The feed derives them
 * server-side (see src/lib/public-hierarchy.ts): a deputy hangs
 * under the holder of the parent role named by the deputy's role
 * definition (parentRoleKey) when exactly one person in the chapter
 * holds it. Everyone else is placed by LEVEL, from the feed's rank
 * order — the chapter's top-ranked holder (its president) roots the
 * tree, the remaining officers form the level beneath, and deputies
 * whose chair is vacant or co-held sit in a dashed level band at the
 * bottom, connected to the level, never to an invented person.
 *
 * SCALE (20+ chapters, 500+ role-holders): there is never one
 * mega-tree. Each chapter is its own subtree inside its own card;
 * past a size threshold (more than 4 sections or 120 people) only
 * National and the first chapter start expanded and every other
 * chapter collapses to a summary card (its president, its counts),
 * so the initial DOM stays bounded no matter how large the society
 * grows. An expanded tree lives on a horizontally scrollable canvas
 * with zoom controls (out, percentage, in, Fit) that keep wide trees
 * usable on a phone, where the List view is the fully vertical
 * alternative. Search runs over the already-fetched payload: in the
 * chart it highlights matching nodes and expands their chapter; in
 * the list it filters. No extra network calls, no new endpoints.
 *
 * Ordering is never re-sorted here: the feed already returns
 * sections and members in rank order, and this page renders them as
 * delivered.
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import {
  ChevronDown,
  List as ListIcon,
  Network,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
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
/* The org chart's connector geometry lives in globals.css under
   the .org-tree prefix (the repo's jest transform cannot load CSS
   modules, and the rules are pure presentation). */

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

function PersonAvatar({
  person,
  className,
  fallbackClassName,
}: {
  person: PublicHierarchyPerson;
  className?: string;
  fallbackClassName?: string;
}) {
  return (
    <Avatar className={className}>
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
          fallbackClassName
        )}
      >
        {initialsOf(person.name)}
      </AvatarFallback>
    </Avatar>
  );
}

function RolePill({ title }: { title: string }) {
  return (
    <span
      title={title}
      className="min-w-0 max-w-full truncate rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
    >
      {title}
    </span>
  );
}

/* ─── List view ─────────────────────────────────────────────────── */

function PersonRow({ person }: { person: PublicHierarchyPerson }) {
  /* Stacked on purpose: the card's job is to identify the PERSON,
     so the name gets its own line and never truncates; the role
     chip sits on the line below and is the element that yields
     (it truncates, with the full title on hover). On one shared
     flex line the chip won and names collapsed to "AD..." —
     founder screenshot, 2026-10-30. */
  return (
    <li className="flex items-start gap-3 rounded-md border border-border/40 bg-background/60 px-3 py-2">
      <PersonAvatar
        person={person}
        className="size-9 shrink-0"
        fallbackClassName="text-xs"
      />
      <div className="min-w-0 flex-1">
        <Link
          href={person.profilePath}
          prefetch={false}
          className="block break-words rounded-sm text-sm font-medium leading-snug underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {person.name}
        </Link>
        <span className="mt-1 flex min-w-0 items-center gap-1.5">
          <RolePill title={person.roleTitle} />
          {person.isCustomRole ? (
            <CustomRoleMarker className="shrink-0" />
          ) : null}
        </span>
      </div>
    </li>
  );
}

/* ─── Chart view ────────────────────────────────────────────────── */

function NodeCard({
  person,
  nodeId,
  tone = 'officer',
  matched = false,
}: {
  person: PublicHierarchyPerson;
  nodeId: string;
  tone?: 'root' | 'officer' | 'deputy';
  matched?: boolean;
}) {
  return (
    <div
      id={nodeId}
      className={cn(
        'flex flex-col items-center gap-1.5 rounded-lg border bg-background px-3 text-center shadow-sm',
        tone === 'deputy' ? 'w-40 py-2.5' : 'w-44 py-3',
        tone === 'root'
          ? 'border-primary/50 bg-primary/5'
          : 'border-border/60',
        matched && 'bg-primary/10 ring-2 ring-primary ring-offset-2 ring-offset-background'
      )}
    >
      <PersonAvatar
        person={person}
        className={tone === 'root' ? 'size-12' : tone === 'deputy' ? 'size-9' : 'size-10'}
        fallbackClassName={tone === 'root' ? 'text-sm' : 'text-xs'}
      />
      <Link
        href={person.profilePath}
        prefetch={false}
        className="block w-full break-words rounded-sm text-sm font-medium leading-snug underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {person.name}
      </Link>
      <span className="flex w-full min-w-0 max-w-full items-center justify-center gap-1.5">
        <RolePill title={person.roleTitle} />
        {person.isCustomRole ? (
          <CustomRoleMarker className="shrink-0" />
        ) : null}
      </span>
    </div>
  );
}

/** A vertical chain of deputy nodes hanging under one chair node. */
function DeputyChain({
  section,
  indices,
  matches,
}: {
  section: PublicHierarchySection;
  indices: number[];
  matches: Set<number> | null;
}) {
  if (indices.length === 0) return null;
  return (
    <div className="relative mt-3 flex flex-col items-center">
      <span
        aria-hidden="true"
        className="absolute left-1/2 top-0 h-full w-0 -translate-x-1/2 border-l-2 border-border"
      />
      <ul className="flex flex-col items-center gap-2">
        {indices.map((i) => (
          <li key={`${section.members[i].id}-${section.members[i].roleTitle}`} className="relative">
            <NodeCard
              person={section.members[i]}
              nodeId={`hnode-${section.id}-${i}`}
              tone="deputy"
              matched={matches?.has(i) ?? false}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 1.5;

function ChartTree({
  section,
  matches,
}: {
  section: PublicHierarchySection;
  matches: Set<number> | null;
}) {
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Measure the tree's natural (unscaled) size so the sizing box can
  // reserve exactly scale x natural space around the transformed
  // content. ResizeObserver is absent in some test environments;
  // there the box simply falls back to natural flow size.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const update = () =>
      setSize({ w: el.offsetWidth, h: el.offsetHeight });
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [section]);

  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0) return;
    const next = Math.min(1, Math.max(ZOOM_MIN, canvas.clientWidth / size.w));
    setScale(next);
  }, [size.w]);

  /**
   * The tree model, derived from the feed exactly as delivered:
   * member 0 (the section's top-ranked holder) is the root; catalog
   * officers form the level beneath; a custom entry hangs under the
   * member the feed's parents map names; a custom entry with no
   * mapped parent goes to the level band.
   */
  const model = useMemo(() => {
    const officers: number[] = [];
    const band: number[] = [];
    const childrenOf = new Map<number, number[]>();
    section.members.forEach((member, i) => {
      if (i === 0) return;
      const parent = section.parents?.[String(i)];
      if (member.isCustomRole) {
        if (parent !== undefined && parent !== i) {
          const list = childrenOf.get(parent) ?? [];
          list.push(i);
          childrenOf.set(parent, list);
        } else {
          band.push(i);
        }
      } else {
        officers.push(i);
      }
    });
    return { officers, band, childrenOf };
  }, [section]);

  const root = section.members[0];
  if (!root) return null;
  const matched = (i: number) => matches?.has(i) ?? false;

  return (
    <div>
      <div className="mb-2 flex items-center justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Zoom out the ${section.name} chart`}
          disabled={scale <= ZOOM_MIN}
          onClick={() => setScale((s) => Math.max(ZOOM_MIN, +(s - 0.25).toFixed(2)))}
        >
          <ZoomOut aria-hidden="true" />
        </Button>
        <span className="min-w-10 text-center text-xs tabular-nums text-muted-foreground">
          {Math.round(scale * 100)}%
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Zoom in the ${section.name} chart`}
          disabled={scale >= ZOOM_MAX}
          onClick={() => setScale((s) => Math.min(ZOOM_MAX, +(s + 0.25).toFixed(2)))}
        >
          <ZoomIn aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={fit}>
          Fit
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={scale === 1}
          onClick={() => setScale(1)}
        >
          Reset
        </Button>
      </div>
      <div
        ref={canvasRef}
        role="group"
        aria-label={`${section.name} org chart`}
        className="overflow-x-auto pb-2"
      >
        <div
          className="relative mx-auto"
          style={
            size.w > 0
              ? { width: size.w * scale, height: size.h * scale }
              : undefined
          }
        >
          <div
            ref={contentRef}
            className="absolute left-0 top-0 w-max"
            style={{
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          >
            <div className="org-tree">
              <ul className="org-tree-root">
                <li>
                  <NodeCard
                    person={root}
                    nodeId={`hnode-${section.id}-0`}
                    tone="root"
                    matched={matched(0)}
                  />
                  <DeputyChain
                    section={section}
                    indices={model.childrenOf.get(0) ?? []}
                    matches={matches}
                  />
                  {model.officers.length > 0 ? (
                    <ul>
                      {model.officers.map((i) => (
                        <li
                          key={`${section.members[i].id}-${section.members[i].roleTitle}`}
                        >
                          <NodeCard
                            person={section.members[i]}
                            nodeId={`hnode-${section.id}-${i}`}
                            matched={matched(i)}
                          />
                          <DeputyChain
                            section={section}
                            indices={model.childrenOf.get(i) ?? []}
                            matches={matches}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              </ul>
            </div>
            {model.band.length > 0 ? (
              <div className="mt-8 border-t-2 border-dashed border-border/70 px-2 pt-4">
                <p className="sr-only">
                  Role-holders without a seated parent role in this
                  section
                </p>
                <ul className="flex flex-wrap justify-center gap-2">
                  {model.band.map((i) => (
                    <li
                      key={`${section.members[i].id}-${section.members[i].roleTitle}`}
                    >
                      <NodeCard
                        person={section.members[i]}
                        nodeId={`hnode-${section.id}-${i}`}
                        tone="deputy"
                        matched={matched(i)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The collapsed face of a chart section: its root holder + counts. */
function ChartSummary({ section }: { section: PublicHierarchySection }) {
  const root = section.members[0];
  const deputies = section.members.filter((m) => m.isCustomRole).length;
  if (!root) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <PersonAvatar person={root} className="size-9" fallbackClassName="text-xs" />
      <Link
        href={root.profilePath}
        className="rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {root.name}
      </Link>
      <RolePill title={root.roleTitle} />
      <span className="text-sm text-muted-foreground">
        {section.members.length}{' '}
        {section.members.length === 1 ? 'role-holder' : 'role-holders'}
        {deputies > 0
          ? `, including ${deputies} ${deputies === 1 ? 'deputy' : 'deputies'}`
          : ''}
        . Expand the section to see the full chart.
      </span>
    </div>
  );
}

/* ─── Section shell (shared by both views) ──────────────────────── */

function SectionShell({
  section,
  expanded,
  staticHeader,
  showBody,
  onToggle,
  children,
}: {
  section: PublicHierarchySection;
  expanded: boolean;
  staticHeader: boolean;
  showBody: boolean;
  onToggle: (id: string, next: boolean) => void;
  children: React.ReactNode;
}) {
  const isNational = section.id === 'national';
  const headingId = `hierarchy-heading-${section.id}`;
  const panelId = `hierarchy-panel-${section.id}`;
  const countLabel = `${section.members.length} ${
    section.members.length === 1 ? 'role-holder' : 'role-holders'
  }`;

  const headerInner = (
    <>
      <span className="min-w-0 flex-1 truncate">{section.name}</span>
      <span className="shrink-0 text-sm font-normal text-muted-foreground">
        {countLabel}
      </span>
      {staticHeader ? null : (
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
            {staticHeader ? (
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
        {showBody ? (
          <div id={panelId} role="region" aria-labelledby={headingId}>
            <CardContent className="pt-6">{children}</CardContent>
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
  const [view, setView] = useState<'chart' | 'list'>('chart');
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

  const personMatches = useCallback(
    (m: PublicHierarchyPerson) => {
      if (roleFilter !== 'all' && m.roleTitle !== roleFilter) return false;
      const q = query.trim().toLowerCase();
      if (
        q &&
        !m.name.toLowerCase().includes(q) &&
        !m.roleTitle.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    },
    [query, roleFilter]
  );

  const searching = query.trim() !== '' || roleFilter !== 'all';
  const filtering = searching || chapterFilter !== 'all';

  /** List view: sections and members after every filter. */
  const visibleSections = useMemo(() => {
    if (!sections) return [];
    return sections
      .filter((s) => chapterFilter === 'all' || s.id === chapterFilter)
      .map((s) => ({ ...s, members: s.members.filter(personMatches) }))
      .filter((s) => s.members.length > 0);
  }, [sections, chapterFilter, personMatches]);

  const visiblePeople = useMemo(
    () => visibleSections.reduce((n, s) => n + s.members.length, 0),
    [visibleSections]
  );

  /** Chart view: matching member indices per section (highlighting). */
  const matchesBySection = useMemo(() => {
    const map = new Map<string, Set<number>>();
    if (!sections || !searching) return map;
    sections.forEach((s) => {
      const set = new Set<number>();
      s.members.forEach((m, i) => {
        if (personMatches(m)) set.add(i);
      });
      if (set.size > 0) map.set(s.id, set);
    });
    return map;
  }, [sections, searching, personMatches]);

  const totalMatches = useMemo(
    () =>
      [...matchesBySection.values()].reduce((n, set) => n + set.size, 0),
    [matchesBySection]
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

  const onChapterSelect = useCallback(
    (id: string) => {
      setChapterFilter(id);
      // In the chart the chapter select is a jump control: open the
      // chapter and take the reader to it. (In the list it filters.)
      if (view === 'chart' && id !== 'all') {
        setOpen(id, true);
        requestAnimationFrame(() => {
          document
            .getElementById(`hierarchy-${id}`)
            ?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        });
      }
    },
    [view, setOpen]
  );

  const jumpToFirstMatch = useCallback(() => {
    if (!sections) return;
    for (const s of sections) {
      const set = matchesBySection.get(s.id);
      if (set && set.size > 0) {
        const first = Math.min(...set);
        document
          .getElementById(`hnode-${s.id}-${first}`)
          ?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
  }, [sections, matchesBySection]);

  const isOpen = useCallback(
    (section: PublicHierarchySection) =>
      openOverrides[section.id] ?? defaultOpen.has(section.id),
    [openOverrides, defaultOpen]
  );

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
          <div className="mb-4 flex items-center justify-between gap-3">
            <div
              role="radiogroup"
              aria-label="Hierarchy view"
              className="inline-flex rounded-md border border-input p-0.5"
            >
              <button
                type="button"
                role="radio"
                aria-checked={view === 'chart'}
                onClick={() => setView('chart')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  view === 'chart'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <Network aria-hidden="true" className="size-4" />
                Chart
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={view === 'list'}
                onClick={() => setView('list')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  view === 'list'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <ListIcon aria-hidden="true" className="size-4" />
                List
              </button>
            </div>
            <p className="hidden text-sm text-muted-foreground sm:block">
              {view === 'chart'
                ? 'The org chart, top to bottom.'
                : 'Every role-holder as a list.'}
            </p>
          </div>

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
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && view === 'chart') {
                        e.preventDefault();
                        jumpToFirstMatch();
                      }
                    }}
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
                    onChange={(e) => onChapterSelect(e.target.value)}
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
              {view === 'chart'
                ? searching
                  ? totalMatches > 0
                    ? `${totalMatches} matching ${totalMatches === 1 ? 'role-holder' : 'role-holders'} highlighted in the chart. Press Enter in the search box to jump to the first.`
                    : 'No role-holder matches that search.'
                  : 'Search to highlight a role-holder in the chart, or jump to a chapter.'
                : filtering
                  ? `Showing ${visiblePeople} of ${totalPeople} role-holders`
                  : 'Search, filter, or jump to a chapter to find a role-holder.'}
            </p>
          </div>

          {sections.length >= JUMP_NAV_MIN_SECTIONS ? (
            <nav aria-label="Chapters" className="mb-6">
              <ul className="flex gap-2 overflow-x-auto pb-1">
                {(view === 'list' && filtering
                  ? visibleSections
                  : sections
                ).map((s) => (
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

          {view === 'list' ? (
            visibleSections.length === 0 ? (
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
                  <SectionShell
                    key={section.id}
                    section={section}
                    expanded={filtering || isOpen(section)}
                    staticHeader={filtering}
                    showBody={filtering || isOpen(section)}
                    onToggle={setOpen}
                  >
                    <ul
                      className={cn(
                        'grid gap-2 [content-visibility:auto] [contain-intrinsic-size:auto_320px]',
                        section.id === 'national'
                          ? 'grid-cols-1'
                          : 'sm:grid-cols-2'
                      )}
                    >
                      {section.members.map((person) => (
                        <PersonRow
                          key={`${person.id}-${person.roleTitle}`}
                          person={person}
                        />
                      ))}
                    </ul>
                  </SectionShell>
                ))}
              </div>
            )
          ) : searching && totalMatches === 0 ? (
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
              {sections.map((section) => {
                const matches = matchesBySection.get(section.id) ?? null;
                const expanded =
                  isOpen(section) || (searching && (matches?.size ?? 0) > 0);
                return (
                  <SectionShell
                    key={section.id}
                    section={section}
                    expanded={expanded}
                    staticHeader={false}
                    showBody
                    onToggle={setOpen}
                  >
                    {expanded ? (
                      <ChartTree section={section} matches={matches} />
                    ) : (
                      <ChartSummary section={section} />
                    )}
                  </SectionShell>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
