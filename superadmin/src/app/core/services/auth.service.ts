import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { PageKey, PermissionAction, User } from '../models/user.model';
import { TAB_INSTANCE_KEY, TAB_SESSION_KEY } from '../http/tab-session.interceptor';

const API_PREFIX = '/api/superadmin/console';

interface AuthResponse {
  user: User;
  expiresAt: number;
  sessionToken: string;
}

export interface ImpersonationContext {
  actorId: string;
  actorName: string;
  actorEmail: string;
}

interface SessionResponse {
  user: User | null;
  expiresAt: number | null;
  impersonation?: ImpersonationContext | null;
}

interface ImpersonationExchangeResponse {
  sessionToken: string;
  user: User;
  expiresAt: number;
  impersonation: ImpersonationContext;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly tabInstanceId: string;
  private readonly tabChannel = typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel('eh-tab-session');
  private readonly userSignal = signal<User | null>(null);
  private readonly sessionExpiresAtSignal = signal<number | null>(null);
  private readonly impersonationSignal = signal<ImpersonationContext | null>(null);
  private readonly readySignal = signal(false);
  private readonly sessionErrorSignal = signal<string | null>(null);
  private restoring: Promise<void> | null = null;

  readonly currentUser = this.userSignal.asReadonly();
  readonly sessionExpiresAt = this.sessionExpiresAtSignal.asReadonly();
  readonly impersonation = this.impersonationSignal.asReadonly();
  readonly isAuthenticated = computed(() => this.userSignal() !== null);
  readonly sessionReady = this.readySignal.asReadonly();
  readonly sessionError = this.sessionErrorSignal.asReadonly();

  constructor() {
    for (const key of ['eh_accounts', 'eh_session', 'eh_activity', 'eh_lock', 'eh_fails']) {
      localStorage.removeItem(key);
    }
    const inheritedInstanceId = sessionStorage.getItem(TAB_INSTANCE_KEY);
    this.tabInstanceId = inheritedInstanceId ?? crypto.randomUUID();
    sessionStorage.setItem(TAB_INSTANCE_KEY, this.tabInstanceId);
    this.detectDuplicatedTab(inheritedInstanceId);
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => {
        if (this.readySignal() && this.isAuthenticated()) void this.refreshSession();
      });
      setInterval(() => {
        if (this.readySignal() && this.isAuthenticated()) void this.refreshSession();
      }, 30_000);
    }
  }

  restoreSession(): Promise<void> {
    if (this.readySignal()) return Promise.resolve();
    if (!this.restoring) {
      this.restoring = firstValueFrom(
        this.http.get<SessionResponse>(`${API_PREFIX}/auth/me`, { withCredentials: true }),
      )
        .then(({ user, expiresAt, impersonation }) => {
          this.userSignal.set(user);
          this.sessionExpiresAtSignal.set(user ? expiresAt : null);
          this.impersonationSignal.set(user ? impersonation ?? null : null);
          if (!user) sessionStorage.removeItem(TAB_SESSION_KEY);
          this.sessionErrorSignal.set(null);
        })
        .catch((error: unknown) => {
          if (error instanceof HttpErrorResponse && error.status === 401) {
            sessionStorage.removeItem(TAB_SESSION_KEY);
            this.userSignal.set(null);
            this.sessionExpiresAtSignal.set(null);
            this.impersonationSignal.set(null);
            return;
          }
          this.userSignal.set(null);
          this.sessionExpiresAtSignal.set(null);
          this.impersonationSignal.set(null);
          this.sessionErrorSignal.set(
            this.getErrorMessage(error, 'Could not connect to the authentication service.'),
          );
        })
        .finally(() => {
          this.readySignal.set(true);
          this.restoring = null;
        });
    }
    return this.restoring;
  }

  async refreshSession(): Promise<void> {
    try {
      const { user, expiresAt, impersonation } = await firstValueFrom(
        this.http.get<SessionResponse>(`${API_PREFIX}/auth/me`, { withCredentials: true }),
      );
      this.userSignal.set(user);
      this.sessionExpiresAtSignal.set(user ? expiresAt : null);
      this.impersonationSignal.set(user ? impersonation ?? null : null);
      if (!user) sessionStorage.removeItem(TAB_SESSION_KEY);
      this.sessionErrorSignal.set(null);
    } catch (error) {
      this.userSignal.set(null);
      this.sessionExpiresAtSignal.set(null);
      this.impersonationSignal.set(null);
      if (error instanceof HttpErrorResponse && error.status === 401) {
        sessionStorage.removeItem(TAB_SESSION_KEY);
        this.sessionErrorSignal.set(null);
        void this.logoutExpiredSession();
        return;
      }
      this.sessionErrorSignal.set(
        this.getErrorMessage(error, 'Could not refresh your permissions from the server.'),
      );
    }
  }

  async login(email: string, password: string): Promise<{ ok: boolean; message?: string }> {
    sessionStorage.removeItem(TAB_SESSION_KEY);
    try {
      const { user, expiresAt, sessionToken } = await firstValueFrom(
        this.http.post<AuthResponse>(
          `${API_PREFIX}/auth/login`,
          { email, password },
          { withCredentials: true },
        ),
      );
      sessionStorage.setItem(TAB_SESSION_KEY, sessionToken);
      this.userSignal.set(user);
      this.sessionExpiresAtSignal.set(expiresAt);
      this.impersonationSignal.set(null);
      this.sessionErrorSignal.set(null);
      this.readySignal.set(true);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: this.getErrorMessage(error, 'Could not connect to the authentication service.'),
      };
    }
  }

  async logout(): Promise<void> {
    if (this.impersonationSignal()) {
      await this.endImpersonation();
      return;
    }
    await firstValueFrom(
      this.http.post<void>(`${API_PREFIX}/auth/logout`, {}, { withCredentials: true }),
    );
    sessionStorage.removeItem(TAB_SESSION_KEY);
    this.userSignal.set(null);
    this.sessionExpiresAtSignal.set(null);
    this.impersonationSignal.set(null);
    this.readySignal.set(true);
  }

  async exchangeImpersonationLaunch(token: string): Promise<void> {
    sessionStorage.removeItem(TAB_SESSION_KEY);
    const response = await firstValueFrom(
      this.http.post<ImpersonationExchangeResponse>(
        `${API_PREFIX}/auth/impersonation/exchange`,
        { token },
        { withCredentials: false },
      ),
    );
    sessionStorage.setItem(TAB_SESSION_KEY, response.sessionToken);
    this.userSignal.set(response.user);
    this.sessionExpiresAtSignal.set(response.expiresAt);
    this.impersonationSignal.set(response.impersonation);
    this.sessionErrorSignal.set(null);
    this.readySignal.set(true);
  }

  async endImpersonation(): Promise<void> {
    if (!this.impersonationSignal()) return;
    if (sessionStorage.getItem(TAB_SESSION_KEY)) {
      try {
        await firstValueFrom(
          this.http.post<void>(`${API_PREFIX}/auth/logout`, {}, { withCredentials: true }),
        );
      } catch (error) {
        if (!(error instanceof HttpErrorResponse) || error.status !== 401) throw error;
      }
    }
    sessionStorage.removeItem(TAB_SESSION_KEY);
    this.impersonationSignal.set(null);
    this.userSignal.set(null);
    this.sessionExpiresAtSignal.set(null);
    await this.refreshSession();
  }

  setCurrentUser(user: User): void {
    this.userSignal.set(user);
  }

  clearSessionError(): void {
    this.sessionErrorSignal.set(null);
  }

  private detectDuplicatedTab(inheritedInstanceId: string | null): void {
    if (!inheritedInstanceId || !this.tabChannel) return;

    this.tabChannel.addEventListener('message', (event: MessageEvent<{ type?: unknown; instanceId?: unknown }>) => {
      const instanceId = event.data?.instanceId;
      if (instanceId !== this.tabInstanceId) return;
      if (event.data?.type === 'probe') {
        this.tabChannel?.postMessage({ type: 'duplicate', instanceId });
      } else if (event.data?.type === 'duplicate') {
        void this.clearDuplicatedTab();
      }
    });

    setTimeout(() => {
      this.tabChannel?.postMessage({ type: 'probe', instanceId: this.tabInstanceId });
    }, 100);
  }

  private async clearDuplicatedTab(): Promise<void> {
    const tabToken = sessionStorage.getItem(TAB_SESSION_KEY);
    sessionStorage.removeItem(TAB_SESSION_KEY);
    sessionStorage.removeItem(TAB_INSTANCE_KEY);
    this.userSignal.set(null);
    this.sessionExpiresAtSignal.set(null);
    this.impersonationSignal.set(null);
    this.readySignal.set(true);
    if (tabToken) {
      try {
        await firstValueFrom(
          this.http.post<void>(`${API_PREFIX}/auth/logout`, {}, { withCredentials: true }),
        );
      } catch {
        // The duplicate tab must remain signed out even if server cleanup fails.
      }
    }
    await this.router.navigate(['/auth/login']);
  }

  private async logoutExpiredSession(): Promise<void> {
    sessionStorage.removeItem(TAB_SESSION_KEY);
    this.userSignal.set(null);
    this.sessionExpiresAtSignal.set(null);
    this.impersonationSignal.set(null);
    this.readySignal.set(true);
    await this.router.navigate(['/auth/login']);
  }

  canAccess(page: PageKey, action: PermissionAction = 'view'): boolean {
    const user = this.userSignal();
    return !!user && user.permissions[page][action];
  }

  firstAccessibleRoute(): string {
    const user = this.userSignal();
    if (!user) return '/auth/login';
    const firstPage = Object.entries(user.permissions).find(([, permissions]) => permissions.view);
    const page = firstPage?.[0];
    if (!page) return '/profile';
    if (['customer-panel', 'partner-app', 'users', 'activity', 'settings'].includes(page)) {
      return `/modules/${page}`;
    }
    return `/${page}`;
  }

  private getErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      const message = error.error && typeof error.error === 'object'
        ? (error.error as { message?: unknown }).message
        : undefined;
      if (typeof message === 'string') return message;
    }
    return fallback;
  }

}
