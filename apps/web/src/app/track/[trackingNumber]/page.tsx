'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { shippingApi } from '@/lib/api/shipping';
import { formatDate } from '@/lib/format';

export default function TrackingPage() {
  const { trackingNumber } = useParams<{ trackingNumber: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ['track', trackingNumber],
    queryFn: () => shippingApi.track(trackingNumber),
  });

  if (isLoading) return <p className="text-black/50">Loading tracking…</p>;
  if (!data?.found) return <p className="text-red-600">No shipment found for that tracking number.</p>;

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-semibold">{trackingNumber}</h1>
      <p className="mb-6 text-black/60">{data.status?.replace(/_/g, ' ').toLowerCase()}</p>

      <div className="space-y-3">
        {[...(data.events ?? [])].reverse().map((event, i) => (
          <div key={i} className="rounded-lg border border-black/10 p-3 text-sm">
            <p className="font-medium">{event.description}</p>
            <p className="text-black/50">
              {event.location ? `${event.location} · ` : ''}
              {formatDate(event.occurredAt)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
