import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminApiService, PageDefinition, ROLE_LABELS } from '../../../../core/services/admin-api.service';
import {
  AdminUser,
  type PageKey,
  type PermissionAction,
  type PermissionMatrix,
  type Role,
  type RolePermissions,
} from '../../../../core/models/user.model';
import { AuthService } from '../../../../core/services/auth.service';
import { TAB_INSTANCE_KEY, TAB_SESSION_KEY } from '../../../../core/http/tab-session.interceptor';

@Component({
  selector: 'app-users-page',
  imports: [FormsModule],
  templateUrl: './users-page.html',
  styleUrl: './users-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsersPage {
  private readonly api = inject(AdminApiService);
  private readonly auth = inject(AuthService);

  readonly roleLabels = ROLE_LABELS;
  readonly roles: Role[] = ['superadmin', 'admin', 'viewer'];
  readonly actions: PermissionAction[] = ['view', 'create', 'edit', 'delete'];
  readonly query = signal('');
  readonly users = signal<AdminUser[]>([]);
  readonly pages = signal<PageDefinition[]>([]);
  readonly matrix = signal<PermissionMatrix | null>(null);
  readonly accessUserId = signal('');
  readonly userPermissionDraft = signal<RolePermissions | null>(null);
  readonly selectedRole = signal<Role>('admin');
  readonly activeTab = signal<'users' | 'permissions' | 'user-access'>('users');
  readonly loading = signal(true);
  readonly accessLoading = signal(false);
  readonly creating = signal(false);
  readonly openingUserPanelId = signal<string | null>(null);
  readonly deletingUserId = signal<string | null>(null);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  readonly newUser = { name: '', email: '', password: '', role: 'viewer' as Role };

  readonly filteredUsers = computed(() => {
    const query = this.query().trim().toLowerCase();
    return this.users().filter(
      (user) => !query ||
        user.name.toLowerCase().includes(query) ||
        user.email.toLowerCase().includes(query) ||
        user.userCode.toLowerCase().includes(query),
    );
  });

  readonly selectedPermissions = computed(
    () => this.matrix()?.[this.selectedRole()] ?? null,
  );
  readonly accessUser = computed(
    () => this.users().find((user) => user.id === this.accessUserId()) ?? null,
  );
  readonly effectiveUserPermissions = computed(() => {
    const user = this.accessUser();
    if (!user) return null;
    return this.userPermissionDraft() ?? this.matrix()?.[user.role] ?? null;
  });
  readonly currentUserId = computed(() => this.auth.currentUser()?.id);
  readonly isSuperadmin = computed(() => this.auth.currentUser()?.role === 'superadmin');
  readonly canCreateUsers = computed(() => this.auth.canAccess('users', 'create'));
  readonly canEditUsers = computed(() => this.auth.canAccess('users', 'edit'));
  readonly canDeleteUsers = computed(() => this.auth.canAccess('users', 'delete'));
  readonly assignableRoles = computed(() =>
    this.isSuperadmin() ? this.roles : this.roles.filter((role) => role !== 'superadmin'),
  );
  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const users = await this.api.getUsers();
      this.users.set(users);
      if (this.isSuperadmin()) {
        const access = await this.api.getAccessRoles();
        this.pages.set(access.pages);
        this.matrix.set(access.permissions);
      }
    } catch (error) {
      this.error.set(this.api.errorMessage(error, 'Unable to load users and permissions.'));
    } finally {
      this.loading.set(false);
    }
  }

  async createUser(): Promise<void> {
    if (this.creating()) return;
    this.creating.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const user = await this.api.createUser({ ...this.newUser });
      this.users.update((users) => [user, ...users]);
      this.newUser.name = '';
      this.newUser.email = '';
      this.newUser.password = '';
      this.newUser.role = 'viewer';
      this.notice.set(`Account created · reference ID ${user.userCode}.`);
    } catch (error) {
      this.error.set(this.api.errorMessage(error, 'Unable to create the account.'));
    } finally {
      this.creating.set(false);
    }
  }

  async updateUser(user: AdminUser, changes: { role: Role; disabled: boolean }): Promise<void> {
    this.error.set(null);
    this.notice.set(null);
    try {
      const updated = await this.api.updateUser(user.id, changes);
      this.users.update((users) => users.map((entry) => entry.id === updated.id ? updated : entry));
      this.notice.set('Account updated.');
    } catch (error) {
      this.error.set(this.api.errorMessage(error, 'Unable to update the account.'));
    }
  }

  async selectAccessUser(id: string): Promise<void> {
    this.accessUserId.set(id);
    this.userPermissionDraft.set(null);
    this.error.set(null);
    if (!id) return;

    this.accessLoading.set(true);
    try {
      this.userPermissionDraft.set(await this.api.getUserPermissions(id));
    } catch (error) {
      this.error.set(this.api.errorMessage(error, 'Unable to load this user’s access.'));
    } finally {
      this.accessLoading.set(false);
    }
  }

  openUserAccess(user: AdminUser): void {
    if (user.id === this.currentUserId()) return;
    this.activeTab.set('user-access');
    void this.selectAccessUser(user.id);
  }

  canOpenUserPanel(user: AdminUser): boolean {
    return this.isSuperadmin() && this.canEditUsers() && !user.disabled &&
      user.role !== 'superadmin' && user.id !== this.currentUserId();
  }

  canDeleteUser(user: AdminUser): boolean {
    return this.isSuperadmin() && this.canDeleteUsers() &&
      user.role !== 'superadmin' && user.id !== this.currentUserId();
  }

  async deleteUser(user: AdminUser): Promise<void> {
    if (!this.canDeleteUser(user) || this.deletingUserId()) return;
    const confirmed = window.confirm(
      `Permanently delete ${user.name} (${user.email})? Their account, profile picture, and active sessions will be removed.`,
    );
    if (!confirmed) return;

    this.deletingUserId.set(user.id);
    this.error.set(null);
    this.notice.set(null);
    try {
      await this.api.deleteUser(user.id);
      this.users.update((users) => users.filter((entry) => entry.id !== user.id));
      if (this.accessUserId() === user.id) {
        this.accessUserId.set('');
        this.userPermissionDraft.set(null);
      }
      this.notice.set(`Deleted ${user.email}.`);
    } catch (error) {
      this.error.set(this.api.errorMessage(error, 'Unable to delete this account.'));
    } finally {
      this.deletingUserId.set(null);
    }
  }

  async openUserPanel(user: AdminUser): Promise<void> {
    if (!this.canOpenUserPanel(user) || this.openingUserPanelId()) return;
    this.error.set(null);
    this.notice.set(null);

    const newTab = window.open('about:blank', '_blank');
    if (!newTab) {
      this.error.set('Allow pop-ups to open the user panel in a new tab.');
      return;
    }
    try {
      newTab.sessionStorage.setItem(TAB_INSTANCE_KEY, crypto.randomUUID());
      newTab.sessionStorage.removeItem(TAB_SESSION_KEY);
      newTab.opener = null;
    } catch {
      newTab.close();
      this.error.set('The new tab could not be prepared securely. Please try again.');
      return;
    }
    this.error.set(null);
    this.notice.set(null);
    this.openingUserPanelId.set(user.id);
    try {
      const { launchToken } = await this.api.createImpersonationLaunch(user.id);
      const launchUrl = new URL('/session/impersonate', window.location.origin);
      launchUrl.hash = new URLSearchParams({ token: launchToken }).toString();
      newTab.location.replace(launchUrl.href);
      this.notice.set(`Opened ${user.name}'s panel in a new tab. Activity is audited.`);
    } catch (error) {
      newTab.close();
      this.error.set(this.api.errorMessage(error, 'Unable to open this user panel.'));
    } finally {
      this.openingUserPanelId.set(null);
    }
  }

  useRoleDefaults(): void {
    this.userPermissionDraft.set(null);
  }

  setUserPermission(page: PageKey, action: PermissionAction, event: Event): void {
    const current = this.effectiveUserPermissions();
    if (!current) return;
    const checked = (event.target as HTMLInputElement).checked;
    this.userPermissionDraft.set({
      ...current,
      [page]: { ...current[page], [action]: checked },
    });
  }

  async saveUserAccess(): Promise<void> {
    const user = this.accessUser();
    if (!user || user.id === this.currentUserId() || this.saving()) return;

    this.saving.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const permissions = await this.api.updateUserPermissions(
        user.id,
        this.userPermissionDraft(),
      );
      this.userPermissionDraft.set(permissions);
      this.users.update((users) => users.map((entry) =>
        entry.id === user.id ? { ...entry, customAccess: permissions !== null } : entry,
      ));
      this.notice.set(permissions
        ? `Page access saved for ${user.email}.`
        : `${user.email} now inherits ${this.roleLabels[user.role]} role access.`);
    } catch (error) {
      this.error.set(this.api.errorMessage(error, 'Unable to save this user’s access.'));
    } finally {
      this.saving.set(false);
    }
  }

  async savePermissions(): Promise<void> {
    const matrix = this.matrix();
    const role = this.selectedRole();
    if (!matrix || role === 'superadmin') return;

    this.saving.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const updated = await this.api.updateRolePermissions(role, matrix[role]);
      this.matrix.set(updated);
      this.notice.set(`${this.roleLabels[role]} permissions saved.`);
    } catch (error) {
      this.error.set(this.api.errorMessage(error, 'Unable to save role permissions.'));
    } finally {
      this.saving.set(false);
    }
  }

  setPermission(page: PageKey, action: PermissionAction, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.matrix.update((current) => {
      if (!current || this.selectedRole() === 'superadmin') return current;
      const role = this.selectedRole();
      const rolePermissions: RolePermissions = {
        ...current[role],
        [page]: { ...current[role][page], [action]: checked },
      };
      return { ...current, [role]: rolePermissions };
    });
  }

  setRolePagePermissions(page: PageKey, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.matrix.update((current) => {
      const role = this.selectedRole();
      if (!current || role === 'superadmin') return current;
      const permissions: RolePermissions = {
        ...current[role],
        [page]: { view: checked, create: checked, edit: checked, delete: checked },
      };
      return { ...current, [role]: permissions };
    });
  }

  setRoleActionForAllPages(action: PermissionAction, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.matrix.update((current) => {
      const role = this.selectedRole();
      if (!current || role === 'superadmin') return current;
      const permissions = { ...current[role] };
      for (const page of this.pages()) {
        permissions[page.key] = { ...permissions[page.key], [action]: checked };
      }
      return { ...current, [role]: permissions };
    });
  }

  isRolePageChecked(page: PageKey): boolean {
    const permissions = this.selectedPermissions();
    return !!permissions && this.actions.every((action) => permissions[page][action]);
  }

  isRolePageIndeterminate(page: PageKey): boolean {
    const permissions = this.selectedPermissions();
    if (!permissions) return false;
    const granted = this.actions.filter((action) => permissions[page][action]).length;
    return granted > 0 && granted < this.actions.length;
  }

  isRoleActionChecked(action: PermissionAction): boolean {
    const permissions = this.selectedPermissions();
    return !!permissions && this.pages().length > 0
      && this.pages().every((page) => permissions[page.key][action]);
  }

  isRoleActionIndeterminate(action: PermissionAction): boolean {
    const permissions = this.selectedPermissions();
    if (!permissions) return false;
    const granted = this.pages().filter((page) => permissions[page.key][action]).length;
    return granted > 0 && granted < this.pages().length;
  }

  setUserPagePermissions(page: PageKey, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const current = this.effectiveUserPermissions();
    if (!current) return;
    this.userPermissionDraft.set({
      ...current,
      [page]: { view: checked, create: checked, edit: checked, delete: checked },
    });
  }

  setUserActionForAllPages(action: PermissionAction, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const current = this.effectiveUserPermissions();
    if (!current) return;
    const permissions = { ...current };
    for (const page of this.pages()) {
      permissions[page.key] = { ...permissions[page.key], [action]: checked };
    }
    this.userPermissionDraft.set(permissions);
  }

  isUserPageChecked(page: PageKey): boolean {
    const permissions = this.effectiveUserPermissions();
    return !!permissions && this.actions.every((action) => permissions[page][action]);
  }

  isUserPageIndeterminate(page: PageKey): boolean {
    const permissions = this.effectiveUserPermissions();
    if (!permissions) return false;
    const granted = this.actions.filter((action) => permissions[page][action]).length;
    return granted > 0 && granted < this.actions.length;
  }

  isUserActionChecked(action: PermissionAction): boolean {
    const permissions = this.effectiveUserPermissions();
    return !!permissions && this.pages().length > 0
      && this.pages().every((page) => permissions[page.key][action]);
  }

  isUserActionIndeterminate(action: PermissionAction): boolean {
    const permissions = this.effectiveUserPermissions();
    if (!permissions) return false;
    const granted = this.pages().filter((page) => permissions[page.key][action]).length;
    return granted > 0 && granted < this.pages().length;
  }

}
