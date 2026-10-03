import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthTokens, UserView } from '@zed/contracts';

interface AuthState {
  user: UserView | null;
  tokens: AuthTokens | null;
  setSession: (user: UserView, tokens: AuthTokens) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      tokens: null,
      setSession: (user, tokens) => set({ user, tokens }),
      clear: () => set({ user: null, tokens: null }),
    }),
    { name: 'zed-auth' },
  ),
);
