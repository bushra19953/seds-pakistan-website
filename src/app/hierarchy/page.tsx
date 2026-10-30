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
 */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CustomRoleMarker } from '@/components/roles/custom-role-marker';
import type {
  PublicHierarchyPayload,
  PublicHierarchyPerson,
} from '@/lib/public-hierarchy';

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function PersonRow({ person }: { person: PublicHierarchyPerson }) {
  return (
    <li className="flex items-center gap-3 rounded-md border border-border/40 bg-background/60 px-3 py-2">
      {person.photoURL ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={person.photoURL}
          alt=""
          className="h-9 w-9 shrink-0 rounded-full object-cover"
          loading="lazy"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
        >
          {initialsOf(person.name)}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <Link
          href={person.profilePath}
          prefetch={false}
          className="block truncate text-sm font-medium leading-snug underline-offset-4 hover:underline"
        >
          {person.name}
        </Link>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1.5">
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          {person.roleTitle}
        </span>
        {person.isCustomRole ? <CustomRoleMarker /> : null}
      </span>
    </li>
  );
}

export default function HierarchyPage() {
  const [data, setData] = useState<PublicHierarchyPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

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
  const totalPeople =
    sections?.reduce((n, section) => n + section.members.length, 0) ?? 0;

  return (
    <div className="container mx-auto px-4 py-10 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Hierarchy</h1>
        <p className="mt-2 text-muted-foreground">
          Who leads SEDS Pakistan, chapter by chapter: the national
          officers, and each chapter&apos;s president, officers and
          role-holders. Select a name to open that member&apos;s public
          profile.
        </p>
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
        <p className="text-muted-foreground">Loading the hierarchy.</p>
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
        <div className="space-y-8">
          {sections.map((section) => (
            <Card
              key={section.id}
              className="bg-card/80 backdrop-blur-sm border-primary/20"
            >
              <CardHeader>
                <CardTitle className="flex items-baseline justify-between text-lg">
                  <span>{section.name}</span>
                  <span className="text-sm font-normal text-muted-foreground">
                    {section.members.length}{' '}
                    {section.members.length === 1 ? 'role-holder' : 'role-holders'}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {section.members.map((person) => (
                    <PersonRow key={person.id} person={person} />
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
