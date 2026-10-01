"use client";

import React, { useState, useCallback, useRef, useEffect } from 'react';

interface SelectionBox {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
}

interface MarqueeSelectionProps {
    containerRef: React.RefObject<HTMLDivElement>;
    nodePositions: Array<{ id: string; x: number; y: number; width: number; height: number }>;
    onSelectionChange: (selectedIds: Set<string>, additive: boolean) => void;
    disabled?: boolean;
}

export function MarqueeSelection({ containerRef, nodePositions, onSelectionChange, disabled }: MarqueeSelectionProps) {
    const [isSelecting, setIsSelecting] = useState(false);
    const [box, setBox] = useState<SelectionBox | null>(null);
    const startPos = useRef<{ x: number; y: number } | null>(null);
    const isAdditive = useRef(false);

    // Get nodes within selection box
    const getNodesInBox = useCallback((selBox: SelectionBox) => {
        const minX = Math.min(selBox.startX, selBox.endX);
        const maxX = Math.max(selBox.startX, selBox.endX);
        const minY = Math.min(selBox.startY, selBox.endY);
        const maxY = Math.max(selBox.startY, selBox.endY);

        const selected = new Set<string>();

        nodePositions.forEach(node => {
            // Check if node intersects with selection box
            const nodeRight = node.x + node.width;
            const nodeBottom = node.y + node.height;

            const intersects = !(
                node.x > maxX ||
                nodeRight < minX ||
                node.y > maxY ||
                nodeBottom < minY
            );

            if (intersects) {
                selected.add(node.id);
            }
        });

        return selected;
    }, [nodePositions]);

    const handleMouseDown = useCallback((e: MouseEvent) => {
        if (disabled) return;
        if (!containerRef.current) return;

        // Only start marquee on empty space (not on nodes or controls)
        const target = e.target as HTMLElement;
        if (target.closest('.react-flow__node') ||
            target.closest('.react-flow__controls') ||
            target.closest('.react-flow__minimap') ||
            target.closest('button') ||
            target.closest('input')) {
            return;
        }

        const rect = containerRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        startPos.current = { x, y };
        isAdditive.current = e.shiftKey;
        setIsSelecting(true);
        setBox({ startX: x, startY: y, endX: x, endY: y });
    }, [containerRef, disabled]);

    const handleMouseMove = useCallback((e: MouseEvent) => {
        if (!isSelecting || !startPos.current || !containerRef.current) return;

        const rect = containerRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        setBox({
            startX: startPos.current.x,
            startY: startPos.current.y,
            endX: x,
            endY: y
        });
    }, [isSelecting, containerRef]);

    const handleMouseUp = useCallback(() => {
        if (!isSelecting || !box) {
            setIsSelecting(false);
            setBox(null);
            return;
        }

        // Only select if drag was significant (> 10px)
        const width = Math.abs(box.endX - box.startX);
        const height = Math.abs(box.endY - box.startY);

        if (width > 10 || height > 10) {
            const selected = getNodesInBox(box);
            onSelectionChange(selected, isAdditive.current);
        }

        setIsSelecting(false);
        setBox(null);
        startPos.current = null;
    }, [isSelecting, box, getNodesInBox, onSelectionChange]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        container.addEventListener('mousedown', handleMouseDown);
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);

        return () => {
            container.removeEventListener('mousedown', handleMouseDown);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [containerRef, handleMouseDown, handleMouseMove, handleMouseUp]);

    if (!isSelecting || !box) return null;

    const left = Math.min(box.startX, box.endX);
    const top = Math.min(box.startY, box.endY);
    const width = Math.abs(box.endX - box.startX);
    const height = Math.abs(box.endY - box.startY);

    return (
        <div
            className="absolute pointer-events-none z-50"
            style={{
                left: `${left}px`,
                top: `${top}px`,
                width: `${width}px`,
                height: `${height}px`,
                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                border: '2px dashed rgba(59, 130, 246, 0.6)',
                borderRadius: '4px',
            }}
        />
    );
}
