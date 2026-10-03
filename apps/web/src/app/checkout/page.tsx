'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { AddressInput, DeliveryMode, PaymentProviderKey, ShippingProviderKey } from '@zed/contracts';
import { cartApi } from '@/lib/api/cart';
import { shippingApi } from '@/lib/api/shipping';
import { paymentsApi } from '@/lib/api/payments';
import { useAuthStore } from '@/store/auth-store';
import { formatPriceMinor } from '@/lib/format';
import { ApiError } from '@/lib/api-client';

const emptyAddress: AddressInput = {
  fullName: '',
  phone: '',
  email: '',
  countryCode: 'BG',
  city: '',
  postCode: '',
  street: '',
  streetNumber: '',
};

export default function CheckoutPage() {
  const tokens = useAuthStore((s) => s.tokens);
  const user = useAuthStore((s) => s.user);

  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>('ADDRESS');
  const [paymentProvider, setPaymentProvider] = useState<PaymentProviderKey>('STRIPE');
  const [address, setAddress] = useState<AddressInput>({ ...emptyAddress, email: user?.email ?? '' });
  const [selectedServiceCode, setSelectedServiceCode] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [discountCode, setDiscountCode] = useState('');

  const { data: cart } = useQuery({ queryKey: ['cart'], queryFn: cartApi.get, enabled: Boolean(tokens) });

  const { data: providers } = useQuery({
    queryKey: ['payment-providers'],
    queryFn: paymentsApi.providers,
  });

  const canQuote = Boolean(
    address.fullName &&
      address.phone &&
      address.email &&
      address.city &&
      address.postCode &&
      (deliveryMode === 'OFFICE' ? address.officeId : address.street),
  );

  const { data: quotes, isFetching: quoting, isError: quoteFailed, error: quoteError } = useQuery({
    queryKey: [
      'shipping-quote',
      deliveryMode,
      address.fullName,
      address.phone,
      address.email,
      address.city,
      address.postCode,
      address.street,
      address.officeId,
    ],
    queryFn: () => shippingApi.quote({ deliveryMode, address }),
    enabled: Boolean(tokens) && canQuote,
  });

  const selectedQuote = useMemo(
    () => quotes?.find((q) => q.serviceCode === selectedServiceCode) ?? quotes?.[0],
    [quotes, selectedServiceCode],
  );

  const checkout = useMutation({
    mutationFn: () => {
      if (!selectedQuote) throw new Error('Choose a delivery option first');
      return paymentsApi.checkout({
        paymentProvider,
        shippingProvider: selectedQuote.provider as ShippingProviderKey,
        deliveryMode,
        serviceCode: selectedQuote.serviceCode,
        address,
        currency: cart?.currency ?? 'EUR',
        idempotencyKey,
        discountCode: discountCode.trim() || undefined,
      });
    },
    onSuccess: (session) => {
      if (session.redirectUrl) window.location.href = session.redirectUrl;
    },
  });

  if (!tokens) {
    return (
      <div className="py-16 text-center">
        <p className="mb-4">Sign in to check out.</p>
        <Link href="/login" className="rounded-md bg-ink px-6 py-3 text-sm text-paper">
          Sign in
        </Link>
      </div>
    );
  }

  if (!cart || cart.items.length === 0) {
    return <p className="text-black/50">Your cart is empty.</p>;
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_320px]">
      <div className="space-y-8">
        <section>
          <h2 className="mb-3 text-lg font-medium">Delivery address</h2>
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Full name"
              value={address.fullName}
              onChange={(e) => setAddress((a) => ({ ...a, fullName: e.target.value }))}
              className="col-span-2 rounded-lg border border-black/20 px-3 py-2 text-sm"
            />
            <input
              placeholder="Phone"
              value={address.phone}
              onChange={(e) => setAddress((a) => ({ ...a, phone: e.target.value }))}
              className="rounded-lg border border-black/20 px-3 py-2 text-sm"
            />
            <input
              placeholder="Email"
              value={address.email}
              onChange={(e) => setAddress((a) => ({ ...a, email: e.target.value }))}
              className="rounded-lg border border-black/20 px-3 py-2 text-sm"
            />
            <input
              placeholder="City"
              value={address.city}
              onChange={(e) => setAddress((a) => ({ ...a, city: e.target.value }))}
              className="rounded-lg border border-black/20 px-3 py-2 text-sm"
            />
            <input
              placeholder="Post code"
              value={address.postCode}
              onChange={(e) => setAddress((a) => ({ ...a, postCode: e.target.value }))}
              className="rounded-lg border border-black/20 px-3 py-2 text-sm"
            />
            {deliveryMode === 'ADDRESS' && (
              <>
                <input
                  placeholder="Street"
                  value={address.street}
                  onChange={(e) => setAddress((a) => ({ ...a, street: e.target.value }))}
                  className="rounded-lg border border-black/20 px-3 py-2 text-sm"
                />
                <input
                  placeholder="Number"
                  value={address.streetNumber}
                  onChange={(e) => setAddress((a) => ({ ...a, streetNumber: e.target.value }))}
                  className="rounded-lg border border-black/20 px-3 py-2 text-sm"
                />
              </>
            )}
            {deliveryMode === 'OFFICE' && (
              <input
                placeholder="Office id (from courier office picker)"
                value={address.officeId ?? ''}
                onChange={(e) => setAddress((a) => ({ ...a, officeId: e.target.value }))}
                className="col-span-2 rounded-lg border border-black/20 px-3 py-2 text-sm"
              />
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-lg font-medium">Delivery method</h2>
          <div className="flex gap-2 text-sm">
            {(['ADDRESS', 'OFFICE'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setDeliveryMode(mode)}
                className={`rounded-md px-4 py-2 ${deliveryMode === mode ? 'bg-ink text-paper' : 'border border-black/20'}`}
              >
                {mode === 'ADDRESS' ? 'To address' : 'To courier office'}
              </button>
            ))}
          </div>

          {!canQuote && (
            <p className="mt-3 text-sm text-black/50">
              Fill in your name, phone, email and address to see delivery options.
            </p>
          )}

          {quoting && <p className="mt-3 text-sm text-black/50">Getting delivery quotes…</p>}

          {quoteFailed && (
            <p className="mt-3 text-sm text-red-600">
              {quoteError instanceof ApiError ? quoteError.message : 'Could not get a delivery quote for that address.'}
            </p>
          )}

          {canQuote && !quoting && !quoteFailed && quotes && quotes.length === 0 && (
            <p className="mt-3 text-sm text-red-600">No delivery options available for that address.</p>
          )}

          {quotes && quotes.length > 0 && (
            <div className="mt-4 space-y-2">
              {quotes.map((q) => (
                <label
                  key={`${q.provider}-${q.serviceCode}`}
                  className={`flex cursor-pointer items-center justify-between rounded-lg border p-3 text-sm ${
                    selectedQuote?.serviceCode === q.serviceCode ? 'border-ink' : 'border-black/10'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="shipping-option"
                      checked={selectedQuote?.serviceCode === q.serviceCode}
                      onChange={() => setSelectedServiceCode(q.serviceCode)}
                    />
                    {q.serviceName}
                    {q.estimatedDeliveryDays !== null && (
                      <span className="text-black/40">~{q.estimatedDeliveryDays}d</span>
                    )}
                  </span>
                  <span>{formatPriceMinor(q.priceMinor, q.currency)}</span>
                </label>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-lg font-medium">Payment</h2>
          <div className="flex gap-2 text-sm">
            {providers?.providers.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPaymentProvider(p as PaymentProviderKey)}
                className={`rounded-md px-4 py-2 ${paymentProvider === p ? 'bg-ink text-paper' : 'border border-black/20'}`}
              >
                {p === 'STRIPE' ? 'Card (Stripe)' : 'PayPal'}
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="h-fit rounded-lg border border-black/10 p-6">
        <div className="flex justify-between text-sm text-black/60">
          <span>Subtotal</span>
          <span>{formatPriceMinor(cart.subtotalMinor, cart.currency)}</span>
        </div>
        <div className="mt-1 flex justify-between text-sm text-black/60">
          <span>Shipping</span>
          <span>{selectedQuote ? formatPriceMinor(selectedQuote.priceMinor, selectedQuote.currency) : '-'}</span>
        </div>
        <div className="mt-3 flex justify-between border-t border-black/10 pt-3 font-medium">
          <span>Total (before discount)</span>
          <span>
            {formatPriceMinor(cart.subtotalMinor + (selectedQuote?.priceMinor ?? 0), cart.currency)}
          </span>
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-xs text-black/50">Discount code</label>
          <input
            placeholder="e.g. TSHI-AB12CD"
            value={discountCode}
            onChange={(e) => setDiscountCode(e.target.value.toUpperCase())}
            className="w-full rounded-lg border border-black/20 px-3 py-2 text-sm"
          />
        </div>

        {checkout.isError && (
          <p className="mt-3 text-sm text-red-600">
            {checkout.error instanceof ApiError ? checkout.error.message : 'Checkout failed'}
          </p>
        )}

        <button
          type="button"
          disabled={!selectedQuote || checkout.isPending}
          onClick={() => checkout.mutate()}
          className="mt-6 w-full rounded-md bg-ink px-6 py-3 text-sm font-medium text-paper disabled:opacity-40"
        >
          {checkout.isPending ? 'Redirecting…' : 'Pay now'}
        </button>
      </div>
    </div>
  );
}
