import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PAGE_KEYS, type RolePermissions, type User } from '../../core/models/user.model';
import { AdminApiService } from '../../core/services/admin-api.service';
import { AuthService } from '../../core/services/auth.service';
import { NotificationService } from '../../core/services/notification.service';
import { OperationsService } from '../../core/services/operations.service';
import { ProfileApiService } from '../../core/services/profile-api.service';
import { ThemeService } from '../../core/services/theme.service';
import { AdminLayout } from './admin-layout';

const permissions = Object.fromEntries(
  PAGE_KEYS.map((key) => [key, { view: true, create: true, edit: true, delete: true }]),
) as RolePermissions;

function makeUser(role: User['role']): User {
  return {
    id: `${role}-1`,
    userCode: '123-AB_',
    name: 'Taylor Admin',
    email: 'taylor@example.test',
    phone: null,
    role,
    avatarInitials: 'TA',
    avatarUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    accessMode: 'role',
    permissionsAssignedBy: null,
    permissions,
  };
}

describe('AdminLayout notifications access', () => {
  let currentUser: ReturnType<typeof signal<User | null>>;

  beforeEach(async () => {
    currentUser = signal<User | null>(makeUser('superadmin'));
    await TestBed.configureTestingModule({
      imports: [AdminLayout],
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {
            currentUser,
            impersonation: signal(null),
            canAccess: () => true,
            logout: vi.fn(async () => undefined),
          },
        },
        {
          provide: ProfileApiService,
          useValue: {
            avatarImageUrl: signal(null),
            loadAvatar: vi.fn(async () => undefined),
          },
        },
        {
          provide: NotificationService,
          useValue: {
            unreadCount: signal(4),
            refresh: vi.fn(async () => undefined),
            reset: vi.fn(),
          },
        },
        {
          provide: AdminApiService,
          useValue: { errorMessage: (_error: unknown, fallback: string) => fallback },
        },
        {
          provide: OperationsService,
          useValue: { loadAuthorizedData: vi.fn(), operationErrors: [] },
        },
        {
          provide: ThemeService,
          useValue: { mode: signal<'light' | 'dark'>('light'), toggleMode: vi.fn() },
        },
      ],
    }).compileComponents();
  });

  it('shows the notification bell, unread badge, and sidebar entry to Super Admins', () => {
    const fixture = TestBed.createComponent(AdminLayout);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('.notification-bell')?.getAttribute('aria-label'))
      .toBe('Notifications, 4 unread');
    expect(element.querySelector('.notification-badge')?.textContent?.trim()).toBe('4');
    expect(element.querySelector('.nav-link[href="/notifications"]')?.textContent).toContain('Notifications');
  });

  it('hides the notification bell and sidebar entry from Admin accounts', () => {
    currentUser.set(makeUser('admin'));
    const fixture = TestBed.createComponent(AdminLayout);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('.notification-bell')).toBeNull();
    expect(element.querySelector('.nav-link[href="/notifications"]')).toBeNull();
  });

  it('shows the signed-in first name beside the sidebar avatar, not in the header', () => {
    const fixture = TestBed.createComponent(AdminLayout);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('.sidebar-profile-name')?.textContent?.trim()).toBe('Taylor');
    expect(element.querySelector('.header-profile-name')).toBeNull();
  });

  it('searches visible navigation and supports the Ctrl+K shortcut', () => {
    const fixture = TestBed.createComponent(AdminLayout);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const search = element.querySelector<HTMLInputElement>('.header-search input')!;

    search.value = 'Repair';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(element.querySelectorAll('.header-search-results a')).toHaveLength(1);
    expect(element.querySelector('.header-search-results')?.textContent).toContain('Repair Center');

    search.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    expect(document.activeElement).toBe(search);
  });

  it('offers fullscreen and reports when the browser does not support it', async () => {
    const fixture = TestBed.createComponent(AdminLayout);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const fullscreenButton = element.querySelector<HTMLButtonElement>('.fullscreen-toggle')!;

    expect(fullscreenButton.getAttribute('aria-label')).toBe('Enter fullscreen');
    fullscreenButton.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(element.querySelector('[role="alert"]')?.textContent)
      .toContain('Fullscreen is not supported');
  });
});
