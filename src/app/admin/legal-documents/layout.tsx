// The /admin layout already renders the one permission-gated sidebar.
// This segment used to wrap pages in a second, permission-blind sidebar
// (components/layout/admin-layout, deleted 2026-10-22), which doubled the
// navigation on every legal-documents page. Passthrough now.
export default function LegalDocumentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
