import Link from 'next/link';

export function Footer() {
  return (
    <footer className="border-t border-black/10">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-black/50 sm:flex-row sm:items-center sm:justify-between">
        <p>&copy; {new Date().getFullYear()} ProjectZed.</p>
        <div className="flex gap-4">
          <Link href="/terms" className="hover:text-ink">
            Terms and conditions
          </Link>
          <Link href="/privacy" className="hover:text-ink">
            Privacy policy
          </Link>
        </div>
      </div>
    </footer>
  );
}
