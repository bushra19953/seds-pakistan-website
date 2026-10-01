import { type Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Edit Blog Post',
};

export default function EditBlogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
