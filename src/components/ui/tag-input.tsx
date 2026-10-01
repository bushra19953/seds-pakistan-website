import React, { useState, KeyboardEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { X } from 'lucide-react';

interface TagInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}

export function TagInput({ value = [], onChange, placeholder }: TagInputProps) {
  const [inputValue, setInputValue] = useState('');

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const newTag = inputValue.trim();
      const currentTags = Array.isArray(value) ? value : [];
      if (newTag && !currentTags.includes(newTag)) {
        onChange([...currentTags, newTag]);
        setInputValue('');
      }
    } else if (e.key === 'Backspace' && !inputValue && Array.isArray(value) && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const removeTag = (tagToRemove: string) => {
    const currentTags = Array.isArray(value) ? value : [];
    onChange(currentTags.filter(tag => tag !== tagToRemove));
  };

  const currentTags = Array.isArray(value) ? value : [];

  return (
    <div className="flex flex-wrap gap-2 p-2 border border-input rounded-md bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
      {currentTags.map((tag) => (
        <Badge key={tag} variant="secondary" className="flex items-center gap-1 px-2 py-1 text-sm">
          {tag}
          <X
            className="h-3 w-3 cursor-pointer hover:text-destructive"
            onClick={() => removeTag(tag)}
          />
        </Badge>
      ))}
      <input
        type="text"
        className="flex-1 bg-transparent outline-none min-w-[120px] text-sm text-foreground placeholder:text-muted-foreground"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={currentTags.length === 0 ? placeholder : 'Type and press Enter to add...'}
      />
    </div>
  );
}
