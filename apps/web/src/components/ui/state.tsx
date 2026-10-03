export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-10 text-sm text-black/50">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-black/15 border-t-accent"
        aria-hidden
      />
      {label ?? 'Loading…'}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-black/15 py-16 text-center">
      <p className="font-medium text-ink">{title}</p>
      {description && <p className="max-w-sm text-sm text-black/50">{description}</p>}
      {action}
    </div>
  );
}
