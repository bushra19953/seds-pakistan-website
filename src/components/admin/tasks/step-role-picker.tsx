'use client';

/**
 * StepRolePicker (Custom Roles Fix Program, consumers Surface 1;
 * contracts 4.2/4.3). Replaces the step Role free-text input in the
 * task form with a picker fed by ONE options source:
 * getUnifiedRoleOptions(firestore, uid, chapterId) - catalog options
 * as today, plus the chapter's custom roles (active definitions only)
 * when a chapterId is passed. Chapter exclusion is the options
 * source's job; the picker passes its chapter through and renders
 * what the source returns.
 *
 * Selecting an option stores its KEY (a catalog key or a custom
 * slug). Custom options render their definition title plus the
 * Custom marker. Free-text working titles stay possible through the
 * creatable row, which stores the typed text verbatim; Clear empties
 * the value. A stored custom slug displays as its definition title
 * on the trigger, never as the raw slug.
 */

import React, { useEffect, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { useFirestore, useUser } from '@/firebase';
import { getUnifiedRoleOptions, type RoleOption } from '@/lib/unified-roles';
import { isCustomRoleSlug, customRoleTitle } from '@/lib/custom-roles';
import { getCustomRoleDefinitionSync } from '@/lib/custom-role-sync';
import { CustomRoleMarker } from '@/components/roles/custom-role-marker';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';

/** Option label format is `${title} (${key})`; recover the title. */
function titleOf(option: RoleOption): string {
  const suffix = ` (${option.key})`;
  return option.label.endsWith(suffix)
    ? option.label.slice(0, -suffix.length)
    : option.label;
}

export function StepRolePicker({
  id,
  value,
  chapterId,
  onChange,
}: {
  id: string;
  value: string;
  chapterId?: string;
  onChange: (value: string) => void;
}) {
  const firestore = useFirestore();
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [options, setOptions] = useState<RoleOption[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getUnifiedRoleOptions(firestore, user?.uid, chapterId)
      .then((opts) => {
        if (!alive) return;
        setOptions(opts);
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [firestore, user?.uid, chapterId]);

  const catalogOptions = options.filter((o) => !isCustomRoleSlug(o.key));
  const customOptions = options.filter((o) => isCustomRoleSlug(o.key));

  const q = query.trim().toLowerCase();
  const matches = (o: RoleOption) =>
    !q ||
    o.label.toLowerCase().includes(q) ||
    o.key.toLowerCase().includes(q);
  const visibleCatalog = catalogOptions.filter(matches);
  const visibleCustom = customOptions.filter(matches);

  // The creatable row offers the typed text verbatim unless it is
  // already exactly an option (by key or by full label).
  const showCreatable =
    query.trim() !== '' &&
    !options.some((o) => o.key === query || o.label === query);

  const select = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery('');
  };

  // Trigger display: the stored value resolved through the same
  // options source; a custom slug with no option yet falls back to
  // the contracts 4.5 floor (definition name from the sync cache,
  // else the humanised slug) - never the raw slug.
  const selected = options.find((o) => o.key === value);
  let triggerTitle: string | null = null;
  let triggerCustom = false;
  if (value) {
    if (selected) {
      triggerTitle = titleOf(selected);
      triggerCustom = isCustomRoleSlug(selected.key);
    } else if (isCustomRoleSlug(value)) {
      triggerTitle = customRoleTitle(getCustomRoleDefinitionSync(value), value);
      triggerCustom = true;
    } else {
      triggerTitle = value;
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          aria-label="Step role"
          onMouseDown={(e) => e.stopPropagation()}
          className={cn(
            'flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2 text-sm',
            !triggerTitle && 'text-muted-foreground',
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">
              {triggerTitle ?? 'Select a role or type a working title'}
            </span>
            {triggerCustom && <CustomRoleMarker />}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0 z-[9999]"
        side="bottom"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search roles…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {loading && options.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                Loading roles…
              </div>
            ) : (
              <>
                {visibleCatalog.length > 0 && (
                  <CommandGroup heading="Roles">
                    {visibleCatalog.map((o) => (
                      <CommandItem
                        key={o.key}
                        value={o.key}
                        onSelect={() => select(o.key)}
                      >
                        <span>{o.label}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {(visibleCustom.length > 0 ||
                  (chapterId && customOptions.length === 0)) && (
                  <CommandGroup heading="Custom roles">
                    {visibleCustom.map((o) => (
                      <CommandItem
                        key={o.key}
                        value={o.key}
                        onSelect={() => select(o.key)}
                      >
                        <span>{o.label}</span>
                        <CustomRoleMarker className="ml-2" />
                      </CommandItem>
                    ))}
                    {chapterId && customOptions.length === 0 && (
                      <CommandItem value="__no_custom_roles__" disabled>
                        No custom roles in this chapter
                      </CommandItem>
                    )}
                  </CommandGroup>
                )}
                {showCreatable && (
                  <CommandItem
                    value={query}
                    onSelect={() => select(query)}
                  >
                    <span>{`Use as working title: "${query}"`}</span>
                  </CommandItem>
                )}
                {value && (
                  <CommandItem
                    value="__clear_role__"
                    onSelect={() => select('')}
                  >
                    <span>Clear role</span>
                  </CommandItem>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default StepRolePicker;
