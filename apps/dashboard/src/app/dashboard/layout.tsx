import { Sidebar } from '@/components/sidebar';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-56 flex-1 p-6">{children}</main>
    </div>
  );
}
