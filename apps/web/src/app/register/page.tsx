'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { authApi } from '@/lib/api/auth';
import { useAuthStore } from '@/store/auth-store';
import { ApiError } from '@/lib/api-client';

export default function RegisterPage() {
  const router = useRouter();
  const setSession = useAuthStore((s) => s.setSession);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const register = useMutation({
    mutationFn: () => authApi.register({ fullName, email, password }),
    onSuccess: (res) => {
      setSession(res.user, res.tokens);
      router.push('/products');
    },
  });

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-6 text-2xl font-semibold">Create an account</h1>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          register.mutate();
        }}
      >
        <label className="text-sm">
          Full name
          <input
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/20 px-3 py-2"
          />
        </label>
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
          Password (min 10 characters)
          <input
            type="password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/20 px-3 py-2"
          />
        </label>
        {register.isError && (
          <p className="text-sm text-red-600">
            {register.error instanceof ApiError ? register.error.message : 'Registration failed'}
          </p>
        )}
        <button
          type="submit"
          disabled={register.isPending}
          className="rounded-md bg-ink px-6 py-3 text-sm font-medium text-paper disabled:opacity-40"
        >
          {register.isPending ? 'Creating…' : 'Create account'}
        </button>
      </form>
      <p className="mt-4 text-sm text-black/60">
        Already have an account?{' '}
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
