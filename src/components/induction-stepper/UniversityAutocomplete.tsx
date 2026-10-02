"use client";

import React, { useState, useMemo } from "react";
import { useFormContext } from "react-hook-form";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
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
import { useUniversities } from "@/hooks/use-universities";

interface UniversityAutocompleteProps {
    name: string;
    placeholder?: string;
}

export default function UniversityAutocomplete({ name, placeholder }: UniversityAutocompleteProps) {
    const { setValue, watch, formState: { errors } } = useFormContext();
    const { universities, loading, addUniversity } = useUniversities();
    const [open, setOpen] = useState(false);
    const [searchValue, setSearchValue] = useState("");

    const selectedValue = watch(name);

    const filteredUniversities = useMemo(() => {
        if (!searchValue) return universities;
        return universities.filter((u) =>
            u.toLowerCase().includes(searchValue.toLowerCase())
        );
    }, [universities, searchValue]);

    const exactMatch = useMemo(() => {
        return universities.some(u => u.toLowerCase() === searchValue.toLowerCase());
    }, [universities, searchValue]);

    const handleSelect = (val: string) => {
        setValue(name, val, { shouldValidate: true, shouldDirty: true });
        setOpen(false);
        setSearchValue("");
    };

    const handleAddNew = async () => {
        if (!searchValue.trim()) return;
        const newUni = searchValue.trim();
        await addUniversity(newUni);
        handleSelect(newUni);
    };

    return (
        <div className="flex flex-col gap-2">
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={open}
                        className={cn(
                            "w-full justify-between bg-background border-border/50 hover:border-primary/50 transition-colors h-11",
                            !selectedValue && "text-muted-foreground"
                        )}
                    >
                        {selectedValue || placeholder || "Select university..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
                    <Command shouldFilter={false}>
                        <CommandInput
                            placeholder="Search university..."
                            value={searchValue}
                            onValueChange={setSearchValue}
                        />
                        <CommandList>
                            {loading ? (
                                <div className="py-6 text-center text-sm">Loading...</div>
                            ) : (
                                <>
                                    <CommandEmpty className="p-0">
                                        {searchValue.length > 0 && !exactMatch ? (
                                            <div className="p-2">
                                                <p className="text-xs text-muted-foreground mb-2 px-2">University not in our list?</p>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="w-full justify-start text-primary hover:text-primary hover:bg-primary/10 gap-2"
                                                    onClick={handleAddNew}
                                                >
                                                    <Plus className="h-4 w-4" /> Add &quot;{searchValue}&quot;
                                                </Button>
                                            </div>
                                        ) : (
                                            <div className="py-6 text-center text-sm">No university found.</div>
                                        )}
                                    </CommandEmpty>
                                    <CommandGroup heading="Popular Institutes">
                                        {filteredUniversities.map((uni) => (
                                            <CommandItem
                                                key={uni}
                                                value={uni}
                                                onSelect={() => handleSelect(uni)}
                                                className="flex items-center justify-between"
                                            >
                                                {uni}
                                                <Check
                                                    className={cn(
                                                        "h-4 w-4",
                                                        selectedValue === uni ? "opacity-100" : "opacity-0"
                                                    )}
                                                />
                                            </CommandItem>
                                        ))}
                                    </CommandGroup>
                                </>
                            )}
                        </CommandList>
                    </Command>
                </PopoverContent>
            </Popover>
        </div>
    );
}
