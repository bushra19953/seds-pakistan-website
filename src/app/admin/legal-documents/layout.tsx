import AdminLayout from '@/components/layout/admin-layout';

export default function LegalDocumentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AdminLayout title="Legal Documents" description="Manage Terms and Conditions and Privacy Policy">{children}</AdminLayout>;
}
