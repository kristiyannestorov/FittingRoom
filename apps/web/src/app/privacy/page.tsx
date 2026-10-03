import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy policy',
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">Privacy policy</h1>
      <p className="mt-2 text-xs text-black/50">Last updated: 4 September 2026</p>
      <p className="mt-4 rounded-lg bg-black/5 p-4 text-xs text-black/60">
        Placeholder legal text. Replace [Company legal name], [Registered address] and [Contact
        email] with your real details, and have this reviewed by a lawyer before publishing.
      </p>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">1. Who we are</h2>
        <p>
          This policy explains how [Company legal name], registered at [Registered address]
          (&ldquo;we&rdquo;, &ldquo;us&rdquo;), collects and uses your personal data when you use this site.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">2. What we collect</h2>
        <ul className="list-inside list-disc space-y-1">
          <li>Account details: name, email address, password (stored hashed).</li>
          <li>
            The model (male or female) you choose to preview garment fit on.
          </li>
          <li>Order history, delivery address, and cart contents.</li>
          <li>
            Payment confirmation data from Stripe or PayPal. We do not receive or store your full
            card number.
          </li>
          <li>Basic technical data such as your IP address and browser, for security and fraud prevention.</li>
        </ul>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">3. How we use it</h2>
        <ul className="list-inside list-disc space-y-1">
          <li>To render your chosen model and show how items fit before you buy.</li>
          <li>To process, fulfil, and ship your orders.</li>
          <li>To manage your account and respond to support requests.</li>
          <li>To meet our legal and accounting obligations.</li>
        </ul>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">4. Who we share it with</h2>
        <p>We only share what each provider needs to do its job:</p>
        <ul className="list-inside list-disc space-y-1">
          <li>Stripe and PayPal, to process payment.</li>
          <li>Econt and Speedy, to deliver your order.</li>
          <li>Our hosting and storage providers, to run the site and store your order data securely.</li>
        </ul>
        <p>We do not sell your personal data.</p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">5. How long we keep it</h2>
        <p>
          We keep account and order data for as long as your account is active and afterwards
          only as long as needed to meet tax and accounting obligations. You can ask us to delete
          your account data at any time; this does not affect records we must keep for completed
          orders.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">6. Your rights</h2>
        <p>
          Subject to applicable law, you can ask to access, correct, delete, or export your
          personal data, and you can object to or restrict certain processing. To exercise any of
          these, contact us at [Contact email].
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">7. Cookies and sessions</h2>
        <p>
          We use a small number of strictly necessary cookies and local storage entries to keep
          you signed in and to remember your cart. We do not use advertising or tracking cookies.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">8. Security</h2>
        <p>
          We use reasonable technical and organisational measures to protect your data, including
          encryption in transit and hashed passwords. No system is completely secure, and we
          cannot guarantee absolute security.
        </p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">9. Children</h2>
        <p>This site is not directed at children, and we do not knowingly collect data from anyone under 16.</p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">10. Changes to this policy</h2>
        <p>We may update this policy from time to time. We will post the new version here with an updated date.</p>
      </section>

      <section className="mt-8 space-y-3 text-sm text-black/70">
        <h2 className="text-lg font-medium text-ink">11. Contact</h2>
        <p>Questions about this policy or your data can be sent to [Contact email].</p>
      </section>
    </div>
  );
}
