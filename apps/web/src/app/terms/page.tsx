import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms and conditions',
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">Terms and conditions</h1>
      <p className="mt-2 text-xs text-black/50">Last updated: 4 September 2026</p>
      <p className="mt-4 rounded-lg bg-black/5 p-4 text-xs text-black/60">
        Placeholder legal text. Replace [Company legal name], [Registered address] and [Contact
        email] with your real details, and have this reviewed by a lawyer before publishing.
      </p>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">1. Who we are</h2>
        <p>
          ProjectZed is operated by [Company legal name], registered at [Registered address]
          (&ldquo;we&rdquo;, &ldquo;us&rdquo;). These terms govern your use of this website and any purchase you make
          through it.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">2. Accounts</h2>
        <p>
          You need an account to place an order or track a shipment. You are responsible for
          keeping your login details secure and for all activity under your account. Tell us
          straight away if you think someone else has access to it.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">3. Sizing</h2>
        <p>
          The size chart is provided to help you choose a size, not a guarantee of fit. Actual
          garments may vary slightly due to fabric behaviour and manufacturing tolerances.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">4. Orders and pricing</h2>
        <p>
          Prices are shown in EUR and include any taxes stated at checkout. Placing an order is an
          offer to buy; we confirm the contract when we accept your order. We may cancel an order
          and refund you if an item is mispriced, out of stock, or if we suspect fraud.
        </p>
        <p>
          Some items are made to order rather than shipped from stock. Once production has
          started on a made-to-order item, it can no longer be changed or cancelled.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">5. Payment</h2>
        <p>
          Payments are processed by Stripe or PayPal. We do not store your full card details on
          our servers. Your order is only confirmed once payment has been successfully authorised.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">6. Shipping and delivery</h2>
        <p>
          Orders are dispatched using Econt or Speedy. Delivery estimates shown at checkout and on
          your order are provided by the courier and are not guaranteed. Risk in the goods passes
          to you once the order is delivered to the address you provided.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">7. Returns and cancellation</h2>
        <p>
          If you are a consumer ordering a stocked item, you may generally cancel your order and
          return it within 14 days of delivery for a refund, in line with applicable consumer
          protection law. This right does not apply to made-to-order items produced to your
          chosen size and specification, except where the item is faulty or not as described.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">8. Intellectual property</h2>
        <p>
          The site, its design, and the imagery used to present the catalog belong to us or our
          licensors. You may not copy, resell, or reuse them outside of using the site to shop.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">9. Liability</h2>
        <p>
          We are not liable for indirect or consequential losses arising from your use of the
          site. Nothing in these terms limits liability where it cannot be limited by law,
          including for death, personal injury, or fraud.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">10. Governing law</h2>
        <p>These terms are governed by the laws of Bulgaria, without prejudice to any mandatory consumer protections that apply in your country of residence.</p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">11. Changes to these terms</h2>
        <p>
          We may update these terms from time to time. Continuing to use the site after a change
          means you accept the updated terms.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">12. Contact</h2>
        <p>Questions about these terms can be sent to [Contact email].</p>
      </section>
    </div>
  );
}
