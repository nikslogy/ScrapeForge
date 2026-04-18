export function Card({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-charcoal-800 bg-charcoal-900 p-5 ${className}`}>
      {children}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <Card>
      <p className="text-xs font-medium uppercase tracking-wider text-charcoal-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold font-[family-name:var(--font-heading)] ${accent ? 'text-amber-400' : 'text-white'}`}>
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-charcoal-500">{sub}</p>}
    </Card>
  );
}
