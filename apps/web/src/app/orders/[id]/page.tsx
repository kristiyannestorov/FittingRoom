'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ordersApi } from '@/lib/api/orders';
import { formatDate, formatPriceMinor } from '@/lib/format';

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: order, isLoading } = useQuery({
    queryKey: ['order', id],
    queryFn: () => ordersApi.get(id),
  });

  if (isLoading) return <p className="text-black/50">Loading order…</p>;
  if (!order) return <p className="text-red-600">Order not found.</p>;

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_320px]">
      <div>
        <h1 className="text-2xl font-semibold">{order.orderNumber}</h1>
        <p className="mb-6 text-sm text-black/50">{formatDate(order.createdAt)}</p>

        <div className="space-y-3">
          {order.items.map((item) => (
            <div key={item.id} className="flex justify-between rounded-lg border border-black/10 p-4">
              <div>
                <p className="font-medium">{item.productName}</p>
                <p className="text-sm text-black/50">
                  {item.variantName} · Size {item.size} × {item.quantity}
                </p>
              </div>
              <p className="font-medium">
                {formatPriceMinor(item.unitPriceMinor * item.quantity, order.currency)}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-8">
          <h2 className="mb-3 text-lg font-medium">Status history</h2>
          <div className="space-y-2 text-sm">
            {order.statusHistory.map((event, i) => (
              <div key={i} className="flex justify-between border-b border-black/5 pb-2">
                <span>{event.status.replace(/_/g, ' ').toLowerCase()}</span>
                <span className="text-black/40">{formatDate(event.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>

        {order.shipment && (
          <div className="mt-8">
            <h2 className="mb-3 text-lg font-medium">Shipment</h2>
            <p className="text-sm">
              {order.shipment.provider}: {order.shipment.status.replace(/_/g, ' ').toLowerCase()}
            </p>
            {order.shipment.trackingNumber && (
              <Link
                href={`/track/${order.shipment.trackingNumber}`}
                className="mt-2 inline-block text-sm underline"
              >
                Track parcel ({order.shipment.trackingNumber})
              </Link>
            )}
          </div>
        )}
      </div>

      <div className="h-fit rounded-lg border border-black/10 p-6 text-sm">
        <div className="flex justify-between text-black/60">
          <span>Subtotal</span>
          <span>{formatPriceMinor(order.subtotalMinor, order.currency)}</span>
        </div>
        {order.discountMinor > 0 && (
          <div className="mt-1 flex justify-between text-black/60">
            <span>Discount{order.discountCode ? ` (${order.discountCode})` : ''}</span>
            <span>-{formatPriceMinor(order.discountMinor, order.currency)}</span>
          </div>
        )}
        <div className="mt-1 flex justify-between text-black/60">
          <span>Shipping</span>
          <span>{formatPriceMinor(order.shippingMinor, order.currency)}</span>
        </div>
        <div className="mt-3 flex justify-between border-t border-black/10 pt-3 font-medium">
          <span>Total</span>
          <span>{formatPriceMinor(order.totalMinor, order.currency)}</span>
        </div>
        <div className="mt-6 text-black/60">
          <p className="font-medium text-ink">Delivery address</p>
          <p>{order.shippingAddress.fullName}</p>
          <p>
            {order.shippingAddress.street} {order.shippingAddress.streetNumber}
          </p>
          <p>
            {order.shippingAddress.city}, {order.shippingAddress.postCode}
          </p>
        </div>
      </div>
    </div>
  );
}
