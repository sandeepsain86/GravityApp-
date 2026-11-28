import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  PAGE_KEYS,
  type AdminUser,
  type PermissionMatrix,
  type RolePermissions,
  type User,
} from '../../../../core/models/user.model';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { UsersPage } from './users-page';

const permissions = Object.fromEntries(
  PAGE_KEYS.map((key) => [key, { view: true, create: true, edit: true, delete: true }]),
) as RolePermissions;

describe('UsersPage user-panel launch', () => {
  const adminUser: User = {
    id: 'root-id',
    userCode: '123-AB_',
    name: 'Root Admin',
    email: 'root@example.test',
    phone: null,
    role: 'superadmin',
    avatarInitials: 'RA',
    avatarUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    accessMode: 'role',
    permissionsAssignedBy: null,
    permissions,
  };
  const target: AdminUser = {
    id: 'viewer-id',
    userCode: '456-CD_',
    name: 'Viewer Account',
    email: 'viewer@example.test',
    role: 'viewer',
    disabled: false,
    customAccess: false,
    createdAt: '2026-01-02T00:00:00.000Z',
  };

  let fixture: ComponentFixture<UsersPage>;
  let api: {
    createImpersonationLaunch: ReturnType<typeof vi.fn>;
    deleteUser: ReturnType<typeof vi.fn>;
    getUsers: ReturnType<typeof vi.fn>;
    getAccessRoles: ReturnType<typeof vi.fn>;
  };
  let panel: UsersPage;

  beforeEach(async () => {
    api = {
      createImpersonationLaunch: vi.fn(async () => ({ launchToken: 'one-time-token' })),
      deleteUser: vi.fn(async () => undefined),
      getUsers: vi.fn(async () => [target]),
      getAccessRoles: vi.fn(async () => ({
        pages: [],
        permissions: {} as PermissionMatrix,
      })),
    };
    await TestBed.configureTestingModule({
      imports: [UsersPage],
      providers: [
        {
          provide: AuthService,
          useValue: {
            currentUser: signal<User | null>(adminUser),
            canAccess: () => true,
          },
        },
        { provide: AdminApiService, useValue: { ...api, errorMessage: (_error: unknown, fallback: string) => fallback } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(UsersPage);
    panel = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('only allows active non-Superadmin accounts other than the signed-in user', () => {
    expect(panel.canOpenUserPanel(target)).toBe(true);
    expect(panel.canOpenUserPanel({ ...target, disabled: true })).toBe(false);
    expect(panel.canOpenUserPanel({ ...target, role: 'superadmin' })).toBe(false);
    expect(panel.canOpenUserPanel({ ...target, id: adminUser.id })).toBe(false);
  });

  it('renders labeled icon controls for account actions', () => {
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('button[aria-label="Open Viewer Account in a new tab"] svg')).not.toBeNull();
    expect(element.querySelector('button[aria-label="Disable Viewer Account"] svg')).not.toBeNull();
    expect(element.querySelector('button[aria-label="Delete account for Viewer Account"] svg')).not.toBeNull();
  });

  it('shows and searches accounts by their short reference ID', async () => {
    await panel.load();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.user-code')?.textContent?.trim()).toBe('456-CD_');

    const search = element.querySelector<HTMLInputElement>('.search')!;
    search.value = '456-CD_';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();

    expect(panel.filteredUsers().map((user) => user.userCode)).toEqual(['456-CD_']);
  });

  it('opens the one-time launch link directly from the Superadmin session', async () => {
    const replace = vi.fn();
    const newTab = {
      opener: window,
      location: { replace },
      close: vi.fn(),
      sessionStorage: { setItem: vi.fn(), removeItem: vi.fn() },
    } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(newTab);

    await panel.openUserPanel(target);

    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(newTab.opener).toBeNull();
    expect(api.createImpersonationLaunch).toHaveBeenCalledWith(target.id);
    const launchUrl = new URL(replace.mock.calls[0][0] as string);
    expect(launchUrl.pathname).toBe('/session/impersonate');
    expect(new URLSearchParams(launchUrl.hash.slice(1)).get('token')).toBe('one-time-token');
    expect(panel.notice()).toContain('Activity is audited.');
    open.mockRestore();
  });

  it('reports blocked pop-ups without requesting a launch token', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    await panel.openUserPanel(target);

    expect(api.createImpersonationLaunch).not.toHaveBeenCalled();
    expect(panel.error()).toContain('Allow pop-ups');
    open.mockRestore();
  });

  it('requires confirmation before deleting an account and removes it after success', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    await panel.deleteUser(target);

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(target.email));
    expect(api.deleteUser).toHaveBeenCalledWith(target.id);
    expect(panel.users().some((user) => user.id === target.id)).toBe(false);
    expect(panel.notice()).toContain(target.email);
    confirm.mockRestore();
  });

  it('does not send a delete request when the confirmation is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    await panel.deleteUser(target);

    expect(api.deleteUser).not.toHaveBeenCalled();
    expect(panel.users().some((user) => user.id === target.id)).toBe(true);
    confirm.mockRestore();
  });
});
