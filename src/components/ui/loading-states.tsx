import React from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface TableSkeletonProps {
  rows?: number;
  columns?: number;
  className?: string;
}

export function TableSkeleton({ rows = 5, columns = 4, className = '' }: TableSkeletonProps) {
  return (
    <div className={className}>
      <Table>
        <TableHeader>
          <TableRow>
            {Array.from({ length: columns }).map((_, index) => (
              <TableHead key={index}>
                <Skeleton className="h-4 w-full" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, rowIndex) => (
            <TableRow key={rowIndex}>
              {Array.from({ length: columns }).map((_, colIndex) => (
                <TableCell key={colIndex}>
                  <Skeleton className="h-4 w-full" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

interface CardSkeletonProps {
  cards?: number;
  className?: string;
}

export function CardSkeleton({ cards = 3, className = '' }: CardSkeletonProps) {
  return (
    <div className={`grid gap-4 ${className}`}>
      {Array.from({ length: cards }).map((_, index) => (
        <div key={index} className="rounded-lg border p-4">
          <Skeleton className="h-4 w-1/3 mb-2" />
          <Skeleton className="h-8 w-1/2 mb-2" />
          <Skeleton className="h-4 w-full mb-1" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ))}
    </div>
  );
}

interface FormSkeletonProps {
  fields?: number;
  className?: string;
}

export function FormSkeleton({ fields = 4, className = '' }: FormSkeletonProps) {
  return (
    <div className={className}>
      {Array.from({ length: fields }).map((_, index) => (
        <div key={index} className="mb-4">
          <Skeleton className="h-4 w-1/4 mb-2" />
          <Skeleton className="h-10 w-full" />
        </div>
      ))}
      <Skeleton className="h-10 w-32" />
    </div>
  );
}

export default {
  TableSkeleton,
  CardSkeleton,
  FormSkeleton,
};