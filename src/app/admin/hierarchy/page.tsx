"use client";

import { useState } from "react";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { GitMerge } from "lucide-react";
import { ChapterSelector } from "@/components/admin/hierarchy/chapter-selector";
import dynamic from "next/dynamic";

const HierarchyCanvas = dynamic(
  () => import("@/components/admin/hierarchy/hierarchy-canvas"),
  { ssr: false, loading: () => <div className="flex items-center justify-center h-96 text-muted-foreground">Loading org chart…</div> }
);

export default function AdminHierarchyPage() {
    const [selectedChapterId, setSelectedChapterId] = useState<string>("");

    return (
        <AuthorizationGate permission="canViewHierarchy">
            <div className="h-[calc(100vh-100px)] flex flex-col space-y-4">

                {/* Header & Controls */}
                <div className="flex items-center justify-between shrink-0 p-1">
                    <div className="flex flex-col gap-1">
                        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                            <GitMerge className="h-6 w-6 text-primary" />
                            Organization Hierarchy
                        </h1>
                        <p className="text-sm text-muted-foreground">
                            Strict reporting lines. Select a chapter to visualize.
                        </p>
                    </div>
                    <ChapterSelector value={selectedChapterId} onChange={setSelectedChapterId} />
                </div>

                {/* Main Canvas Area */}
                <div className="flex-1 min-h-0 relative">
                    {selectedChapterId ? (
                        <HierarchyCanvas chapterId={selectedChapterId} />
                    ) : (
                        <div className="h-full w-full border-2 border-dashed border-border/50 rounded-xl flex flex-col items-center justify-center bg-slate-50/50 dark:bg-slate-900/20">
                            <div className="bg-background p-4 rounded-full shadow-sm mb-4">
                                <GitMerge className="h-8 w-8 text-muted-foreground" />
                            </div>
                            <h3 className="text-lg font-medium text-foreground">No Chapter Selected</h3>
                            <p className="text-muted-foreground max-w-sm text-center mt-2">
                                Please select a chapter from the top right menu to load the organization chart.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </AuthorizationGate>
    );
}
