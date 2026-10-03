import type { AuthResponse, LoginInput, RegisterInput, UserView } from '@zed/contracts';
import { apiRequest } from '../api-client';

export const authApi = {
  register: (input: RegisterInput) =>
    apiRequest<AuthResponse>('/auth/register', { method: 'POST', body: input, anonymous: true }),

  login: (input: LoginInput) =>
    apiRequest<AuthResponse>('/auth/login', { method: 'POST', body: input, anonymous: true }),

  logout: (refreshToken: string) =>
    apiRequest<void>('/auth/logout', { method: 'POST', body: { refreshToken }, anonymous: true }),

  me: () => apiRequest<UserView>('/auth/me'),
};
