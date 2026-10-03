'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProductionTicketStatus } from '@zed/contracts';
import { adminApi } from '@/lib/api/admin';

const NEXT_STATUS: Partial<Record<ProductionTicketStatus, ProductionTicketStatus>> = {
  QUEUED: 'IN_PROGRESS',
  IN_PROGRESS: 'COMPLETED',
};

const NEXT_LABEL: Partial<Record<ProductionTicketStatus, string>> = {
  QUEUED: 'Start',
  IN_PROGRESS: 'Mark complete',
};

export default function AdminProductionPage() {
  const queryClient = useQueryClient();

  const { data: tickets, isLoading } = useQuery({
    queryKey: ['production-tickets'],
    queryFn: () => adminApi.production.list(),
  });

  const setStatus = useMutation({
    mutationFn: ({ ticketId, status }: { ticketId: string; status: ProductionTicketStatus }) =>
      adminApi.production.setStatus(ticketId, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['production-tickets'] }),
  });

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Production queue</h1>
      <p className="mb-6 text-sm text-black/50">
        Made-to-order line items. An order ships automatically once every ticket on it is
        completed.
      </p>

      {isLoading && <p className="text-black/50">Loading…</p>}
      {tickets?.length === 0 && <p className="text-black/50">Nothing queued.</p>}

      <div className="space-y-3">
        {tickets?.map((ticket) => {
          const next = NEXT_STATUS[ticket.status];
          return (
            <div key={ticket.id} className="flex items-center justify-between rounded-lg border border-black/10 p-4">
              <div>
                <p className="font-medium">
                  {ticket.orderItem.productName} · {ticket.orderItem.variantName} · {ticket.orderItem.size}
                </p>
                <p className="text-sm text-black/50">
                  Order {ticket.orderItem.order.orderNumber} · {ticket.status.toLowerCase()}
                </p>
              </div>
              {next && (
                <button
                  type="button"
                  onClick={() => setStatus.mutate({ ticketId: ticket.id, status: next })}
                  className="rounded-md border border-black/20 px-4 py-2 text-sm hover:bg-black/5"
                >
                  {NEXT_LABEL[ticket.status]}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
