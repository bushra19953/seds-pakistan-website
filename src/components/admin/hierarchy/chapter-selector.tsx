"use client";

import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { useCollection } from "@/firebase/firestore/use-collection";
import { useFirestore } from "@/firebase";
import { collection, query, where } from "firebase/firestore";
import { useMemoFirebase } from "@/lib/use-memo-firebase";

interface ChapterSelectorProps {
    value: string;
    onChange: (val: string) => void;
}

export function ChapterSelector({ value, onChange }: ChapterSelectorProps) {
    const [open, setOpen] = React.useState(false);
    const firestore = useFirestore();

    // Real-time chapter fetch
    const chaptersQuery = useMemoFirebase(() => query(collection(firestore, "chapters"), where("isActive", "==", true)), [firestore]);
    const { data: chaptersData, loading } = useCollection(chaptersQuery);

    const chapters = React.useMemo(() => {
        // Sort real chapters
        const list = (chaptersData || []).map((doc: any) => ({
            value: doc.id,
            label: doc.name || doc.id
        })).sort((a: any, b: any) => a.label.localeCompare(b.label));

        // Prepend 'All Chapters'
        return [
            { value: 'all', label: 'All Chapters (Entire Organization)' },
            ...list
        ];
    }, [chaptersData]);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    className="w-[300px] justify-between bg-black/20 border-white/10 text-white hover:bg-white/5 hover:text-white"
                >
                    {value
                        ? chapters.find((c: any) => c.value === value)?.label
                        : loading ? "Loading chapters..." : "Select chapter..."}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[300px] p-0 bg-slate-900 border-slate-700 text-slate-100">
                <Command className="bg-slate-900 text-slate-100">
                    <CommandInput placeholder="Search chapter..." className="text-white" />
                    <CommandList>
                        <CommandEmpty>No chapter found.</CommandEmpty>
                        <CommandGroup>
                            {chapters.map((c: any) => (
                                <CommandItem
                                    key={c.value}
                                    value={c.label}
                                    className="data-[selected=true]:bg-slate-800 data-[selected=true]:text-white aria-selected:bg-slate-800 aria-selected:text-white"
                                    onSelect={(currentValue) => {
                                        // We need the ID, not the label, so find it back
                                        const id = chapters.find((ch: any) => ch.label.toLowerCase() === currentValue.toLowerCase())?.value;
                                        if (id) {
                                            onChange(id);
                                            setOpen(false);
                                        }
                                    }}
                                >
                                    <Check
                                        className={cn(
                                            "mr-2 h-4 w-4",
                                            value === c.value ? "opacity-100" : "opacity-0"
                                        )}
                                    />
                                    {c.label}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
