import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  AdminUser,
  AuditEntry,
  PermissionMatrix,
  PlatformRegistration,
  PlatformRegistrationDetails,
  Role,
  RolePermissions,
} from '../models/user.model';

const API_PREFIX = '/api/superadmin/console';

export const ROLE_LABELS: Record<Role, string> = {
  superadmin: 'Superadmin',
  admin: 'Admin',
  viewer: 'Viewer',
};

export interface PageDefinition {
  key: keyof PermissionMatrix[Role];
  label: string;
  group: string;
}

export interface AccessRolesResponse {
  roles: Role[];
  pages: PageDefinition[];
  permissions: PermissionMatrix;
}

export interface OperationAssignment {
  changed: boolean;
  jobId: string;
  reference: string;
  partnerId: string | null;
  partnerName?: string;
  assignedAt?: string;
}

export interface OperationRepairTransition {
  id: string;
  ticketNumber: string;
  status: string;
  stage: string;
  fromStatus: string;
  updatedAt: string;
}

export interface ProjectMilestoneInput {
  title?: string;
  status?: string;
  plannedStart?: string | null;
  dueDate?: string;
  clientSignoffStatus?: string;
  leadEngineerName?: string | null;
  budgetAmount?: number | null;
  materialCost?: number | null;
  partnerPayout?: number | null;
  billedAmount?: number | null;
}

@Injectable({ providedIn: 'root' })
export class AdminApiService {
  private readonly http = inject(HttpClient);

  getOperations<T>(domain: string): Promise<T> {
    return firstValueFrom(
      this.http.get<T>(
        `${API_PREFIX}/admin/operations/${encodeURIComponent(domain)}`,
        { withCredentials: true },
      ),
    );
  }

  async assignOperationJob(reference: string, partnerId: string | null): Promise<OperationAssignment> {
    const response = await firstValueFrom(
      this.http.patch<{ assignment: OperationAssignment }>(
        `${API_PREFIX}/admin/operations/jobs/${encodeURIComponent(reference)}/assignment`,
        { partnerId },
        { withCredentials: true },
      ),
    );
    return response.assignment;
  }

  async transitionRepairStage(
    reference: string,
    stage: string,
    remarks: string,
    details?: {
      estimatedCost?: number;
      quoteApproved?: boolean;
      parts?: Array<{ sku: string; name: string; quantity: number }>;
      benchPartnerId?: string;
      benchPartnerName?: string;
    },
  ): Promise<OperationRepairTransition> {
    const response = await firstValueFrom(
      this.http.patch<{ repair: OperationRepairTransition }>(
        `${API_PREFIX}/admin/operations/repairs/${encodeURIComponent(reference)}/stage`,
        { stage, remarks, ...details },
        { withCredentials: true },
      ),
    );
    return response.repair;
  }

  async transitionProjectStatus(
    reference: string,
    status: string,
    note = '',
  ): Promise<{ id: string; request_number: string; status: string }> {
    const response = await firstValueFrom(
      this.http.patch<{ project: { id: string; request_number: string; status: string } }>(
        `${API_PREFIX}/admin/operations/projects/${encodeURIComponent(reference)}/status`,
        { status, note },
        { withCredentials: true },
      ),
    );
    return response.project;
  }

  async createProjectMilestone(
    reference: string,
    milestone: ProjectMilestoneInput,
  ): Promise<void> {
    await firstValueFrom(
      this.http.post<{ milestone: unknown }>(
        `${API_PREFIX}/admin/operations/projects/${encodeURIComponent(reference)}/milestones`,
        milestone,
        { withCredentials: true },
      ),
    );
  }

  async updateProjectMilestone(
    reference: string,
    milestoneId: string,
    changes: ProjectMilestoneInput,
  ): Promise<void> {
    await firstValueFrom(
      this.http.patch<{ milestone: unknown }>(
        `${API_PREFIX}/admin/operations/projects/${encodeURIComponent(reference)}/milestones/${encodeURIComponent(milestoneId)}`,
        changes,
        { withCredentials: true },
      ),
    );
  }

  async getUsers(): Promise<AdminUser[]> {
    const response = await firstValueFrom(
      this.http.get<{ users: AdminUser[] }>(`${API_PREFIX}/admin/users`, { withCredentials: true }),
    );
    return response.users;
  }

  async createImpersonationLaunch(userId: string): Promise<{ launchToken: string }> {
    return firstValueFrom(
      this.http.post<{ launchToken: string }>(
        `${API_PREFIX}/admin/users/${encodeURIComponent(userId)}/impersonation`,
        {},
        { withCredentials: true },
      ),
    );
  }

  async getRegistrations(): Promise<PlatformRegistration[]> {
    const response = await firstValueFrom(
      this.http.get<{ registrations: PlatformRegistration[] }>(
        `${API_PREFIX}/admin/registrations`,
        { withCredentials: true },
      ),
    );
    return response.registrations;
  }

  async getRegistrationDetails(id: string): Promise<PlatformRegistrationDetails> {
    const response = await firstValueFrom(
      this.http.get<{ details: PlatformRegistrationDetails }>(
        `${API_PREFIX}/admin/registrations/${encodeURIComponent(id)}`,
        { withCredentials: true },
      ),
    );
    return response.details;
  }

  async openTrackingProfile(id: string): Promise<PlatformRegistrationDetails> {
    const response = await firstValueFrom(
      this.http.post<{ details: PlatformRegistrationDetails }>(
        `${API_PREFIX}/admin/registrations/${encodeURIComponent(id)}/tracking-access`,
        {},
        { withCredentials: true },
      ),
    );
    return response.details;
  }

  async createUser(input: {
    name: string;
    email: string;
    password: string;
    role: Role;
  }): Promise<AdminUser> {
    const response = await firstValueFrom(
      this.http.post<{ user: AdminUser }>(`${API_PREFIX}/admin/users`, input, { withCredentials: true }),
    );
    return response.user;
  }

  async updateUser(
    id: string,
    changes: { role: Role; disabled: boolean },
  ): Promise<AdminUser> {
    const response = await firstValueFrom(
      this.http.patch<{ user: AdminUser }>(
        `${API_PREFIX}/admin/users/${encodeURIComponent(id)}`,
        changes,
        { withCredentials: true },
      ),
    );
    return response.user;
  }

  async deleteUser(id: string): Promise<void> {
    await firstValueFrom(
      this.http.delete<void>(
        `${API_PREFIX}/admin/users/${encodeURIComponent(id)}`,
        { withCredentials: true },
      ),
    );
  }

  async getUserPermissions(id: string): Promise<RolePermissions | null> {
    const response = await firstValueFrom(
      this.http.get<{ permissions: RolePermissions | null }>(
        `${API_PREFIX}/admin/users/${encodeURIComponent(id)}/permissions`,
        { withCredentials: true },
      ),
    );
    return response.permissions;
  }

  async updateUserPermissions(
    id: string,
    permissions: RolePermissions | null,
  ): Promise<RolePermissions | null> {
    const response = await firstValueFrom(
      this.http.put<{ permissions: RolePermissions | null }>(
        `${API_PREFIX}/admin/users/${encodeURIComponent(id)}/permissions`,
        { permissions },
        { withCredentials: true },
      ),
    );
    return response.permissions;
  }

  async getAccessRoles(): Promise<AccessRolesResponse> {
    return firstValueFrom(
      this.http.get<AccessRolesResponse>(`${API_PREFIX}/access/roles`, { withCredentials: true }),
    );
  }

  async updateRolePermissions(role: Role, permissions: RolePermissions): Promise<PermissionMatrix> {
    const response = await firstValueFrom(
      this.http.put<{ permissions: PermissionMatrix }>(
        `${API_PREFIX}/access/roles/${role}`,
        { permissions },
        { withCredentials: true },
      ),
    );
    return response.permissions;
  }

  async getAuditEvents(): Promise<AuditEntry[]> {
    const response = await firstValueFrom(
      this.http.get<{ events: AuditEntry[] }>(`${API_PREFIX}/admin/audit`, { withCredentials: true }),
    );
    return response.events;
  }

  errorMessage(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      const message = error.error && typeof error.error === 'object'
        ? (error.error as { message?: unknown }).message
        : undefined;
      if (typeof message === 'string') return message;
    }
    return fallback;
  }
}
