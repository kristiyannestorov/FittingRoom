'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminApi, type EmailStatus } from '@/lib/api/admin';
import { formatDate } from '@/lib/format';
import { Spinner, EmptyState } from '@/components/ui/state';

const STATUSES: EmailStatus[] = ['sent', 'pending', 'failed'];

export default function AdminEmailsPage() {
  const [statusFilter, setStatusFilter] = useState<EmailStatus | ''>('');
  const [templateFilter, setTemplateFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-emails', statusFilter, templateFilter],
    queryFn: () => adminApi.emails.list(statusFilter || undefined, templateFilter || undefined),
  });

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Emails</h1>
      <p className="mb-6 text-sm text-black/50">
        Every transactional email queued by the app, with delivery status and the exact payload
        that was sent.
      </p>

      <div className="mb-6 flex flex-wrap gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as EmailStatus | '')}
          className="rounded-lg border border-black/20 px-3 py-2 text-sm"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          value={templateFilter}
          onChange={(e) => setTemplateFilter(e.target.value)}
          placeholder="Filter by template (e.g. order-confirmed)"
          className="rounded-lg border border-black/20 px-3 py-2 text-sm"
        />
      </div>

      {isLoading && <Spinner label="Loading emails…" />}
      {data && data.items.length === 0 && <EmptyState title="No emails match this filter" />}

      <div className="space-y-2">
        {data?.items.map((email) => {
          const status = email.sentAt ? 'sent' : email.failedAt ? 'failed' : 'pending';
          const expanded = expandedId === email.id;
          return (
            <div key={email.id} className="rounded-lg border border-black/10 p-4">
              <button
                type="button"
                onClick={() => setExpandedId(expanded ? null : email.id)}
                className="flex w-full items-center justify-between text-left text-sm"
              >
                <div>
                  <p className="font-medium">{email.subject}</p>
                  <p className="text-black/50">
                    {email.toEmail} &middot; {email.template} &middot; {formatDate(email.createdAt)}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-1 text-xs font-medium ${
                    status === 'sent'
                      ? 'bg-green-100 text-green-700'
                      : status === 'failed'
                        ? 'bg-red-100 text-red-700'
                        : 'bg-black/10 text-black/60'
                  }`}
                >
                  {status}
                </span>
              </button>
              {expanded && (
                <div className="mt-4 space-y-3 border-t border-black/10 pt-4 text-xs">
                  <p>
                    Attempts: <span className="font-medium">{email.attempts}</span>
                  </p>
                  {email.error && (
                    <p className="text-red-600">
                      Error: <span className="font-mono">{email.error}</span>
                    </p>
                  )}
                  <pre className="overflow-x-auto rounded-lg bg-black/5 p-3">
                    {JSON.stringify(email.payload, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
