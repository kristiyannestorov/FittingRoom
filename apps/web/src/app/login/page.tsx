'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { authApi } from '@/lib/api/auth';
import { useAuthStore } from '@/store/auth-store';
import { ApiError } from '@/lib/api-client';

export default function LoginPage() {
  const router = useRouter();
  const setSession = useAuthStore((s) => s.setSession);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => authApi.login({ email, password }),
    onSuccess: (res) => {
      setSession(res.user, res.tokens);
      router.push('/products');
    },
  });

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-6 text-2xl font-semibold">Sign in</h1>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <label className="text-sm">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/20 px-3 py-2"
          />
        </label>
        <label className="text-sm">
          Password
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/20 px-3 py-2"
          />
        </label>
        {login.isError && (
          <p className="text-sm text-red-600">
            {login.error instanceof ApiError ? login.error.message : 'Sign in failed'}
          </p>
        )}
        <button
          type="submit"
          disabled={login.isPending}
          className="rounded-md bg-ink px-6 py-3 text-sm font-medium text-paper disabled:opacity-40"
        >
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="mt-4 text-sm text-black/60">
        No account?{' '}
        <Link href="/register" className="underline">
          Register
        </Link>
      </p>
    </div>
  );
}
