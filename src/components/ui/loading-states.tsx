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
  /** Number of single-line input fields (label + input rows). */
  fields?: number;
  /** Number of multi-line textarea fields (label + tall input rows). */
  textareas?: number;
  /** Render fields in a two-column grid for wider forms. */
  twoColumn?: boolean;
  /** Render a section heading skeleton above the fields. */
  showHeading?: boolean;
  /** Render the submit button skeleton. */
  showSubmit?: boolean;
  /** Width class for the submit button skeleton. */
  submitWidth?: string;
  className?: string;
}

export function FormSkeleton({
  fields = 4,
  textareas = 0,
  twoColumn = false,
  showHeading = false,
  showSubmit = true,
  submitWidth = 'w-32',
  className = '',
}: FormSkeletonProps) {
  const fieldBlocks = (
    <>
      {Array.from({ length: fields }).map((_, index) => (
        <div key={`field-${index}`} className="mb-4">
          <Skeleton className="h-4 w-1/4 mb-2" />
          <Skeleton className="h-10 w-full" />
        </div>
      ))}
      {Array.from({ length: textareas }).map((_, index) => (
        <div key={`textarea-${index}`} className="mb-4">
          <Skeleton className="h-4 w-1/4 mb-2" />
          <Skeleton className="h-24 w-full" />
        </div>
      ))}
    </>
  );

  return (
    <div className={className}>
      {showHeading && (
        <div className="mb-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-2/3 mt-2" />
        </div>
      )}
      {twoColumn ? (
        <div className="grid gap-x-4 sm:grid-cols-2">{fieldBlocks}</div>
      ) : (
        fieldBlocks
      )}
      {showSubmit && <Skeleton className={`h-10 ${submitWidth}`} />}
    </div>
  );
}

export default {
  TableSkeleton,
  CardSkeleton,
  FormSkeleton,
};