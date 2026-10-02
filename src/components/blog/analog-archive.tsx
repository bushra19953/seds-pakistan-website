'use client';

import { useMemo, useState } from 'react';
import { FileText, Download, Calendar, User, ExternalLink, Search, Filter, Archive } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Link from 'next/link';
import type { ArchiveDocument } from '@/lib/blog-types';

// File type is derived from the document URL for display/search; the
// producer schema (blog-types) does not store it separately.
function fileTypeOf(url: string): string {
  const ext = url.split('?')[0].split('.').pop();
  return (ext && ext.length <= 5 ? ext : 'file').toUpperCase();
}

interface AnalogArchiveProps {
  documents?: ArchiveDocument[];
  title?: string;
  className?: string;
  allowDownloads?: boolean;
}

// No default documents: component renders only if Firestore provides data

export function AnalogArchive({ 
  documents, 
  title = "Archive",
  className = "",
  allowDownloads = false,
}: AnalogArchiveProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<'all' | string>('all');

  // Use provided documents only; no dummy fallbacks
  const archiveDocuments = documents ?? [];

  const categories = useMemo(() => {
    const set = new Set<string>();
    archiveDocuments.forEach(doc => set.add(doc.category));
    return ['all', ...Array.from(set)].filter(Boolean);
  }, [archiveDocuments]);

  const filtered = useMemo(() => {
    return archiveDocuments.filter(doc => {
      const matchesCategory = selectedCategory === 'all' || doc.category === selectedCategory;
      const term = searchTerm.toLowerCase().trim();
      const matchesTerm = !term ||
        doc.title.toLowerCase().includes(term) ||
        doc.description.toLowerCase().includes(term) ||
        doc.author.toLowerCase().includes(term) ||
        doc.tags.some(t => t.toLowerCase().includes(term)) ||
        fileTypeOf(doc.imageUrl).toLowerCase().includes(term);
      return matchesCategory && matchesTerm;
    });
  }, [archiveDocuments, selectedCategory, searchTerm]);

  if (!archiveDocuments || archiveDocuments.length === 0) {
    return null;
  }

  return (
    <div className={className}>
      {/* Header and Controls */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Archive className="h-5 w-5 text-amber-300" />
          <h3 className="text-xl font-semibold text-amber-300">{title}</h3>
          <Badge variant="outline" className="border-amber-400/30 text-amber-300 bg-amber-400/10">
            {archiveDocuments.length} items
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search archive..."
              className="pl-8 w-56 bg-black/40 border-amber-400/20"
            />
          </div>
          <div className="flex items-center gap-1">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="bg-black/40 border border-amber-400/20 text-sm rounded px-2 py-1"
            >
              {categories.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Documents Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map((doc) => (
          <Card key={doc.id} className="bg-gradient-to-br from-amber-50/5 to-orange-50/5 border-amber-400/20">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-amber-300" />
                  <CardTitle className="text-amber-300 text-base">{doc.title}</CardTitle>
                </div>
                <Badge variant="outline" className="text-xs border-amber-400/30 text-amber-300 bg-amber-400/10">
                  {doc.category}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{doc.description}</p>
              <div className="flex items-center gap-4 text-xs">
                <div className="flex items-center gap-1">
                  <Calendar className="h-4 w-4 text-amber-400" />
                  <span className="text-muted-foreground">{doc.date}</span>
                </div>
                <div className="flex items-center gap-1">
                  <User className="h-4 w-4 text-amber-400" />
                  <span className="text-muted-foreground">{doc.author}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Badge variant="outline" className="text-xs border-amber-400/30 text-amber-300 bg-amber-400/10">
                    {fileTypeOf(doc.imageUrl)}
                  </Badge>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {(doc.tags ?? []).map((tag, i) => (
                  <Badge key={i} variant="outline" className="text-xs border-amber-400/30 text-amber-300 bg-amber-400/5">
                    {tag}
                  </Badge>
                ))}
              </div>
              {allowDownloads && (
                <div className="flex justify-end gap-2 pt-2">
                  <Button asChild variant="outline" className="border-amber-400/30 text-amber-300 hover:bg-amber-400/10">
                    <a href={doc.imageUrl} target="_blank" rel="noopener noreferrer">
                      <Download className="h-4 w-4 mr-1" /> Download
                    </a>
                  </Button>
                  <Button asChild className="bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border-amber-400/20">
                    <a href={doc.imageUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-4 w-4 mr-1" /> Open
                    </a>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
