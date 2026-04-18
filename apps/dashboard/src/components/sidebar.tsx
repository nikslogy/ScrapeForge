'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const nav = [
  { href: '/dashboard', label: 'Overview', icon: ChartIcon, external: false },
  { href: '/dashboard/api-keys', label: 'API Keys', icon: KeyIcon, external: false },
  { href: '/dashboard/usage', label: 'Usage', icon: BarIcon, external: false },
  { href: '/dashboard/logs', label: 'Logs', icon: ListIcon, external: false },
  { href: '/dashboard/playground', label: 'Playground', icon: PlayIcon, external: false },
  { href: '/dashboard/settings', label: 'Settings', icon: GearIcon, external: false },
] as const;

const docsHref =
  process.env.NEXT_PUBLIC_DOCS_URL || 'http://localhost:3000/docs';

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-56 flex-col border-r border-charcoal-800 bg-charcoal-900">
      <div className="flex h-14 items-center gap-2 border-b border-charcoal-800 px-4">
        <span className="text-amber-500 font-[family-name:var(--font-heading)] text-lg font-bold tracking-tight">
          ScrapeForge
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`group flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors
                ${active
                  ? 'bg-amber-500/10 text-amber-400'
                  : 'text-charcoal-500 hover:bg-charcoal-800 hover:text-white'
                }`}
            >
              <Icon className={`h-4 w-4 ${active ? 'text-amber-400' : 'text-charcoal-600 group-hover:text-charcoal-500'}`} />
              {label}
            </Link>
          );
        })}

        <div className="my-2 border-t border-charcoal-800/70" />

        <a
          href={docsHref}
          target="_blank"
          rel="noreferrer"
          className="group flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-charcoal-500 transition-colors hover:bg-charcoal-800 hover:text-white"
        >
          <DocsIcon className="h-4 w-4 text-charcoal-600 group-hover:text-charcoal-500" />
          API Docs
          <ExternalIcon className="ml-auto h-3 w-3 text-charcoal-700 group-hover:text-charcoal-500" />
        </a>
      </nav>

      <div className="border-t border-charcoal-800 px-4 py-3 text-xs text-charcoal-600">
        v1.0.0
      </div>
    </aside>
  );
}

// Minimal inline SVG icons to avoid dependency on icon libs
function ChartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" /><path d="M7 16l4-8 4 4 4-8" />
    </svg>
  );
}
function KeyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}
function BarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="12" width="4" height="8" rx="1" /><rect x="10" y="8" width="4" height="12" rx="1" /><rect x="17" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}
function ListIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" />
    </svg>
  );
}
function PlayIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}
function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1.08z" />
    </svg>
  );
}
function DocsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
function ExternalIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
