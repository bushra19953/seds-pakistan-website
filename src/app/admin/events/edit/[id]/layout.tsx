import { type Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Edit Event',
};

export default function EditEventLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
