import React, { useState, useRef, KeyboardEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { X, Plus } from 'lucide-react';

interface TagInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}

export function TagInput({ value = [], onChange, placeholder }: TagInputProps) {
  const [inputValue, setInputValue] = useState('');
  const addButtonRef = useRef<HTMLButtonElement>(null);
  // K2: IME composition guard for mobile keyboards (Gboard, Samsung, iOS).
  const composingRef = useRef(false);

  // K5: single defensive normalization of the tags list; every handler and
  // the render use this instead of repeated Array.isArray ternaries.
  const tags = Array.isArray(value) ? value : [];

  const commitTag = () => {
    const newTag = inputValue.trim();
    if (newTag && !tags.includes(newTag)) {
      onChange([...tags, newTag]);
      setInputValue('');
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // K2: never commit while IME composition is in progress. Mobile keyboards
    // send keyCode 229 / key 'Unidentified' mid-composition, and committing
    // that partial text is a second bug.
    if ((e.nativeEvent as any).isComposing || composingRef.current) {
      return;
    }
    const isEnter =
      e.key === 'Enter' ||
      (e as any).keyCode === 13 ||
      (e.nativeEvent as any).keyCode === 13;
    if (isEnter) {
      e.preventDefault();
      commitTag();
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  // K2: track IME composition so handleKeyDown can return early mid-composition.
  const handleCompositionStart = () => {
    composingRef.current = true;
  };

  const handleCompositionEnd = () => {
    composingRef.current = false;
  };

  // K2: catch soft-keyboard "go"/"done" keys that emit an insertLineBreak
  // beforeinput without ever firing keydown.
  const handleBeforeInput = (e: React.FormEvent<HTMLInputElement>) => {
    const inputType = (e.nativeEvent as any).inputType;
    if (inputType === 'insertLineBreak') {
      e.preventDefault();
      commitTag();
    }
  };

  // K5: strip newline/carriage-return characters from typed input (stray
  // insertLineBreak / IME artifacts); keep every other character.
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value.replace(/[\r\n]/g, ''));
  };

  const handleBlur = () => {
    if (document.activeElement !== addButtonRef.current) {
      commitTag();
    }
  };

  const removeTag = (tagToRemove: string) => {
    onChange(tags.filter(tag => tag !== tagToRemove));
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pastedText = e.clipboardData.getData('text');
    // Single token with no delimiter: let it paste normally into the input
    if (!/[,;\n\r]/.test(pastedText)) {
      return;
    }
    e.preventDefault();
    const seen = new Set(tags);
    const newTags: string[] = [];
    for (const raw of pastedText.split(/[,;\n\r]+/)) {
      const tag = raw.trim();
      if (tag && !seen.has(tag)) {
        seen.add(tag);
        newTags.push(tag);
      }
    }
    if (newTags.length > 0) {
      onChange([...tags, ...newTags].slice(0, 20));
      setInputValue('');
    }
  };

  return (
    <div className="flex flex-wrap gap-2 p-2 border border-input rounded-md bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary" className="flex items-center gap-1 px-2 py-1 text-sm">
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            onClick={() => removeTag(tag)}
            className="flex items-center justify-center h-6 w-6 p-1 -m-1 rounded-full cursor-pointer hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </Badge>
      ))}
      <input
        type="text"
        className="flex-1 bg-transparent outline-none min-w-[120px] text-sm text-foreground placeholder:text-muted-foreground"
        value={inputValue}
        onChange={handleInputChange}
        maxLength={60}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onBeforeInput={handleBeforeInput}
        onPaste={handlePaste}
        onBlur={handleBlur}
        placeholder={tags.length === 0 ? placeholder : 'Type and press Enter to add...'}
      />
      <button
        ref={addButtonRef}
        type="button"
        aria-label="Add skill"
        onClick={commitTag}
        onMouseDown={(e) => e.preventDefault()}
        className="flex items-center justify-center min-h-[44px] min-w-[44px] rounded-md border border-input bg-background text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
