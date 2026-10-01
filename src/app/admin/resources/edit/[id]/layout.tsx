import { type Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Edit Resource',
};

export default function EditResourceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
