"use client";

import * as React from "react";
import { X, Check, ChevronDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type MultiSelectProps = {
  options: { label: string; value: string }[];
  selected: string[];
  onSelectedChange: (selected: string[]) => void;
  placeholder?: string;
  className?: string;
};

export function MultiSelect({
  options,
  selected,
  onSelectedChange,
  placeholder,
  className,
}: MultiSelectProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [open, setOpen] = React.useState(false);
  const [inputValue, setInputValue] = React.useState("");

  // Locally filter options based on inputValue to avoid relying on cmdk input outside provider
  const filteredOptions = React.useMemo(() => {
    const q = inputValue.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
    );
  }, [options, inputValue]);

  const handleSelect = React.useCallback((value: string) => {
    onSelectedChange(
      selected.includes(value)
        ? selected.filter((item) => item !== value)
        : [...selected, value]
    );
    setInputValue("");
  }, [selected, onSelectedChange]);

  const handleRemove = React.useCallback((value: string) => {
    onSelectedChange(selected.filter((item) => item !== value));
  }, [selected, onSelectedChange]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const input = inputRef.current;
      if (input) {
        if (event.key === "Delete" || event.key === "Backspace") {
          if (input.value === "" && selected.length > 0) {
            onSelectedChange(selected.slice(0, -1));
          }
        }
        // If input is blank, open dropdown when arrow is pressed
        if (event.key === "ArrowDown" && input.value === "") {
          setOpen(true);
        }
      }
    },
    [selected, onSelectedChange]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          className={`relative flex min-h-[36px] h-auto w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
          onClick={() => inputRef.current?.focus()}
        >
          <div className="flex flex-wrap gap-1">
            {selected.map((value) => {
              const option = options.find((o) => o.value === value);
              return (
                <Badge key={value} variant="secondary">
                  {option?.label || value}
                  <button
                    className="ml-1 rounded-full outline-none ring-offset-background focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleRemove(value)}
                  >
                    <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                  </button>
                </Badge>
              );
            })}
            <input
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className="ml-2 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </div>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command>
          <CommandList>
            <CommandGroup>
              {filteredOptions.map((option) => (
                <CommandItem
                  key={option.value}
                  onSelect={() => handleSelect(option.value)}
                  className="flex items-center justify-between"
                >
                  {option.label}
                  {selected.includes(option.value) && <Check className="h-4 w-4" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}