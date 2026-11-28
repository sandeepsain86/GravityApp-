import express, { Router, type Response } from 'express5';
import {
  isRole,
  PAGES,
  ROLES,
  validateRolePermissions,
  type PermissionMatrix,
  type Role,
} from '../domain/permissions.js';
import type {
  AuditEvent,
  CompanyProfile,
  PlatformRegistration,
  PlatformRegistrationDetails,
  StoredUser,
} from '../domain/models.js';
import { InvalidProfileImageError, JsonStore, StoreConflictError } from '../infrastructure/json-store.js';
import { AccessControlService, InputError, NotFoundError } from '../services/access-control.js';
import { AuthenticationService, PasswordChangeError } from '../services/authentication.js';
import { InvalidSessionError, SessionManager } from '../services/sessions.js';
import {
  readSessionCredential,
  requireAuth,
  requirePermission,
  requireSuperadmin,
} from './middleware.js';

interface ApiDependencies {
  store: JsonStore;
  access: AccessControlService;
  authentication: AuthenticationService;
  sessions: SessionManager;
  secureCookies: boolean;
  platformDirectory?: {
    listRegistrations(): Promise<PlatformRegistration[]>;
    getRegistrationDetails(id: string): Promise<PlatformRegistrationDetails | null>;
  };
  operationsDirectory?: {
    getData(domain: string): Promise<unknown>;
    assignJob?(reference: string, partnerId: string | null, actor: StoredUser): Promise<{
      changed: boolean;
      jobId: string;
      reference: string;
      partnerId: string | null;
      partnerName?: string;
      assignedAt?: string;
    }>;
    transitionRepairStage?(
      reference: string,
      stage: string,
      remarks: string,
      details: Record<string, unknown>,
      actor: StoredUser,
    ): Promise<{
      id: string;
      ticketNumber: string;
      status: string;
      stage: string;
      fromStatus: string;
      updatedAt: string;
    }>;
    updateRepairWorkshop?(
      reference: string,
      changes: {
        benchPartnerId?: string | null;
        partRequest?: { sku: string; quantity: number };
      },
      actor: StoredUser,
    ): Promise<{
      id: string;
      ticketNumber: string;
      status: string;
      stage: string;
      fromStatus: string;
      updatedAt: string;
    }>;
    assignRepairPartnerToMany?(
      references: string[],
      partnerId: string,
      actor: StoredUser,
    ): Promise<{
      partnerId: string;
      partnerName: string;
      repairs: Array<{
        id: string;
        ticketNumber: string;
        status: string;
        stage: string;
        fromStatus: string;
        updatedAt: string;
      }>;
    }>;
    transitionProjectStatus?(
      reference: string,
      status: string,
      note: string,
      actor: StoredUser,
    ): Promise<{ id: string; request_number: string; status: string; updated_at: string }>;
    createProjectMilestone?(
      reference: string,
      input: Record<string, unknown>,
      actor: StoredUser,
    ): Promise<Record<string, unknown>>;
    updateProjectMilestone?(
      reference: string,
      milestoneId: string,
      input: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
  };
}

const OPERATION_PAGES: Record<string, string> = {
  jobs: 'jobs',
  livemonitor: 'livemonitor',
  verification: 'verification',
  disputes: 'disputes',
  companies: 'companies',
  amc: 'amc',
  finance: 'finance',
  invoices: 'invoices',
  inventory: 'inventory',
  repair: 'repair',
  projects: 'projects',
  analytics: 'analytics',
  'partner-app': 'partner-app',
};

const IMPERSONATION_AUDIT_REASON = 'Superadmin initiated user-panel access';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function publicUser(user: StoredUser) {
  if (!user.userCode) throw new Error('The user reference code is unavailable.');
  return {
    id: user.id,
    userCode: user.userCode,
    name: user.name,
    email: user.email,
    role: user.role,
    disabled: user.disabled,
    customAccess: !!user.permissions,
    createdAt: user.createdAt,
  };
}

function parseUserInput(body: unknown): { name: string; email: string; password: string; role: Role } | null {
  if (!isRecord(body) || typeof body.name !== 'string' || typeof body.email !== 'string' ||
      typeof body.password !== 'string' || !isRole(body.role)) return null;
  return { name: body.name, email: body.email, password: body.password, role: body.role };
}

function parseUserUpdate(body: unknown): { role: Role; disabled: boolean } | null {
  if (!isRecord(body) || !isRole(body.role) || typeof body.disabled !== 'boolean') return null;
  return { role: body.role, disabled: body.disabled };
}

function parseProfileInput(
  body: unknown,
): { name: string; phone: string | null; completeSetup?: boolean } | null {
  if (!isRecord(body) || typeof body.name !== 'string' ||
      Object.keys(body).some((key) => !['name', 'phone', 'completeSetup'].includes(key)) ||
      ('completeSetup' in body && typeof body.completeSetup !== 'boolean')) return null;
  const phone = body.phone;
  if (phone !== null && typeof phone !== 'string') return null;
  return {
    name: body.name,
    phone,
    ...(body.completeSetup === true ? { completeSetup: true } : {}),
  };
}

function parseCompanyProfileInput(body: unknown): CompanyProfile | null {
  if (!isRecord(body) ||
      typeof body.companyName !== 'string' ||
      typeof body.phone !== 'string' ||
      typeof body.email !== 'string' ||
      typeof body.gstin !== 'string' ||
      Object.keys(body).some((key) =>
        !['companyName', 'phone', 'email', 'gstin'].includes(key))) return null;

  const companyProfile: CompanyProfile = {
    companyName: body.companyName.trim(),
    phone: body.phone.trim(),
    email: body.email.trim().toLowerCase(),
    gstin: body.gstin.trim().toUpperCase(),
  };
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const gstinPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
  const phonePattern = /^[+()\d.\-\s]+$/;
  if (companyProfile.companyName.length > 150 ||
      companyProfile.phone.length > 32 ||
      (companyProfile.phone.length > 0 &&
        (companyProfile.phone.length < 6 || !phonePattern.test(companyProfile.phone))) ||
      companyProfile.email.length > 254 ||
      (companyProfile.email.length > 0 && !emailPattern.test(companyProfile.email)) ||
      (companyProfile.gstin.length > 0 && !gstinPattern.test(companyProfile.gstin))) return null;
  return companyProfile;
}

function parsePasswordInput(body: unknown): { currentPassword: string; newPassword: string } | null {
  if (!isRecord(body) ||
      typeof body.currentPassword !== 'string' ||
      typeof body.newPassword !== 'string' ||
      Object.keys(body).some((key) => key !== 'currentPassword' && key !== 'newPassword')) return null;
  return { currentPassword: body.currentPassword, newPassword: body.newPassword };
}

function sendServiceError(response: Response, error: unknown): void {
  if (error instanceof InputError) {
    response.status(400).json({ message: error.message });
  } else if (error instanceof NotFoundError) {
    response.status(404).json({ message: error.message });
  } else if (error instanceof StoreConflictError) {
    response.status(409).json({ message: error.message });
  } else {
    throw error;
  }
}

export function createApiRouter(dependencies: ApiDependencies): Router {
  const {
    store,
    access,
    authentication,
    sessions,
    secureCookies,
    platformDirectory,
    operationsDirectory,
  } = dependencies;
  const router = Router();
  const authenticate = requireAuth(store, sessions, access);

  router.get(
    '/admin/operations/:domain',
    authenticate,
    async (request, response): Promise<void> => {
      const domain = request.params['domain'];
      const page = typeof domain === 'string' ? OPERATION_PAGES[domain] : undefined;
      if (!page) {
        response.status(404).json({ message: 'The operations data source was not found.' });
        return;
      }
      if (!(await access.can(request.authUser!, page, 'view'))) {
        response.status(403).json({ message: 'You do not have permission to view this operations data.' });
        return;
      }
      if (!operationsDirectory) {
        response.status(503).json({ message: 'The operations database is unavailable.' });
        return;
      }
      const data = await operationsDirectory.getData(domain);
      if (!data) {
        response.status(404).json({ message: 'The operations data source was not found.' });
        return;
      }
      response.json(data);
    },
  );

  router.patch(
    '/admin/operations/projects/:projectId/status',
    authenticate,
    requirePermission(access, 'projects', 'edit'),
    async (request, response): Promise<void> => {
      const projectId = request.params['projectId'];
      const body = request.body as Record<string, unknown> | undefined;
      if (typeof projectId !== 'string' || !body ||
          Object.keys(body).some((key) => !['status', 'note'].includes(key)) ||
          typeof body.status !== 'string' ||
          (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 500))) {
        response.status(400).json({ message: 'Provide a valid project status and an optional note of at most 500 characters.' });
        return;
      }
      if (!operationsDirectory?.transitionProjectStatus) {
        response.status(503).json({ message: 'The project workflow is unavailable.' });
        return;
      }
      try {
        const project = await operationsDirectory.transitionProjectStatus(
          projectId,
          body.status,
          typeof body.note === 'string' ? body.note.trim() : '',
          request.authUser!,
        );
        await store.recordAudit(
          request.authUser!,
          'projects.status_changed',
          'project_request',
          project.request_number,
          { id: project.id, status: project.status },
        );
        response.json({ project });
      } catch (error) {
        const statusCode = error instanceof Error && 'statusCode' in error
          ? error.statusCode
          : undefined;
        if (typeof statusCode === 'number' && [400, 404, 409].includes(statusCode)) {
          response.status(statusCode).json({
            message: error instanceof Error ? error.message : 'Project status could not be changed.',
          });
          return;
        }
        throw error;
      }
    },
  );

  router.post(
    '/admin/operations/projects/:projectId/milestones',
    authenticate,
    requirePermission(access, 'projects', 'edit'),
    async (request, response): Promise<void> => {
      const projectId = request.params['projectId'];
      const body = request.body as Record<string, unknown> | undefined;
      if (typeof projectId !== 'string' || !body) {
        response.status(400).json({ message: 'Provide valid project milestone details.' });
        return;
      }
      if (!operationsDirectory?.createProjectMilestone) {
        response.status(503).json({ message: 'Project milestone management is unavailable.' });
        return;
      }
      try {
        const milestone = await operationsDirectory.createProjectMilestone(
          projectId,
          body,
          request.authUser!,
        );
        await store.recordAudit(
          request.authUser!,
          'projects.milestone_created',
          'project_milestone',
          String(milestone.id),
          { projectId, title: milestone.title, dueDate: milestone.due_date },
        );
        response.status(201).json({ milestone });
      } catch (error) {
        const statusCode = error instanceof Error && 'statusCode' in error
          ? error.statusCode
          : undefined;
        if (typeof statusCode === 'number' && [400, 404, 409].includes(statusCode)) {
          response.status(statusCode).json({
            message: error instanceof Error ? error.message : 'Project milestone could not be created.',
          });
          return;
        }
        throw error;
      }
    },
  );

  router.patch(
    '/admin/operations/projects/:projectId/milestones/:milestoneId',
    authenticate,
    requirePermission(access, 'projects', 'edit'),
    async (request, response): Promise<void> => {
      const projectId = request.params['projectId'];
      const milestoneId = request.params['milestoneId'];
      const body = request.body as Record<string, unknown> | undefined;
      if (typeof projectId !== 'string' || typeof milestoneId !== 'string' || !body) {
        response.status(400).json({ message: 'Provide valid project milestone details.' });
        return;
      }
      if (!operationsDirectory?.updateProjectMilestone) {
        response.status(503).json({ message: 'Project milestone management is unavailable.' });
        return;
      }
      try {
        const milestone = await operationsDirectory.updateProjectMilestone(projectId, milestoneId, body);
        await store.recordAudit(
          request.authUser!,
          'projects.milestone_updated',
          'project_milestone',
          String(milestone.id),
          { projectId, status: milestone.status, clientSignoffStatus: milestone.client_signoff_status },
        );
        response.json({ milestone });
      } catch (error) {
        const statusCode = error instanceof Error && 'statusCode' in error
          ? error.statusCode
          : undefined;
        if (typeof statusCode === 'number' && [400, 404, 409].includes(statusCode)) {
          response.status(statusCode).json({
            message: error instanceof Error ? error.message : 'Project milestone could not be updated.',
          });
          return;
        }
        throw error;
      }
    },
  );

  router.patch(
    '/admin/operations/jobs/:jobId/assignment',
    authenticate,
    requirePermission(access, 'jobs', 'edit'),
    async (request, response): Promise<void> => {
      const jobId = request.params['jobId'];
      const body = request.body as Record<string, unknown> | undefined;
      if (typeof jobId !== 'string' || !body ||
          !('partnerId' in body) ||
          (body.partnerId !== null && typeof body.partnerId !== 'string')) {
        response.status(400).json({ message: 'A job reference and partner ID (or null to unassign) are required.' });
        return;
      }
      if (!operationsDirectory?.assignJob) {
        response.status(503).json({ message: 'The job dispatch service is unavailable.' });
        return;
      }
      try {
        const result = await operationsDirectory.assignJob(jobId, body.partnerId as string | null, request.authUser!);
        if (result.changed) {
          await store.recordAudit(
            request.authUser!,
            result.partnerId ? 'jobs.partner_assigned' : 'jobs.partner_unassigned',
            'job',
            result.reference,
            { partnerId: result.partnerId, providerJobId: result.jobId },
          );
        }
        response.json({ assignment: result });
      } catch (error) {
        const statusCode = error instanceof Error && 'statusCode' in error
          ? error.statusCode
          : undefined;
        if (typeof statusCode === 'number' && [400, 404, 409].includes(statusCode)) {
          response.status(statusCode).json({
            message: error instanceof Error ? error.message : 'Job assignment could not be completed.',
          });
          return;
        }
        throw error;
      }
    },
  );

  router.patch(
    '/admin/operations/repairs/assignment',
    authenticate,
    requirePermission(access, 'repair', 'edit'),
    async (request, response): Promise<void> => {
      const body = request.body as Record<string, unknown> | undefined;
      const references = body?.references;
      if (!body ||
          Object.keys(body).some((key) => !['references', 'partnerId'].includes(key)) ||
          !Array.isArray(references) ||
          references.length < 1 ||
          references.length > 100 ||
          references.some((reference) =>
            typeof reference !== 'string' || reference.trim().length === 0 || reference.length > 120,
          ) ||
          typeof body.partnerId !== 'string' ||
          body.partnerId.trim().length === 0 ||
          body.partnerId.length > 120) {
        response.status(400).json({ message: 'Select between 1 and 100 repair tickets and a valid partner.' });
        return;
      }
      if (!operationsDirectory?.assignRepairPartnerToMany) {
        response.status(503).json({ message: 'Bulk repair assignment is unavailable.' });
        return;
      }
      try {
        const result = await operationsDirectory.assignRepairPartnerToMany(
          references.map((reference) => reference.trim()),
          body.partnerId.trim(),
          request.authUser!,
        );
        await store.recordAudit(
          request.authUser!,
          'repair.partner_bulk_assigned',
          'repair_ticket',
          result.partnerName,
          { partnerId: result.partnerId, ticketCount: result.repairs.length },
        );
        response.json({ assignment: result });
      } catch (error) {
        const statusCode = error instanceof Error && 'statusCode' in error
          ? error.statusCode
          : undefined;
        if (typeof statusCode === 'number' && [400, 404, 409].includes(statusCode)) {
          response.status(statusCode).json({
            message: error instanceof Error ? error.message : 'Bulk repair assignment failed.',
          });
          return;
        }
        throw error;
      }
    },
  );

  router.patch(
    '/admin/operations/repairs/:ticketId/workshop',
    authenticate,
    requirePermission(access, 'repair', 'edit'),
    async (request, response): Promise<void> => {
      const ticketId = request.params['ticketId'];
      const body = request.body as Record<string, unknown> | undefined;
      const partRequest = body?.partRequest;
      const validPartRequest = isRecord(partRequest) &&
        Object.keys(partRequest).every((key) => key === 'sku' || key === 'quantity') &&
        typeof partRequest.sku === 'string' &&
        partRequest.sku.trim().length > 0 &&
        partRequest.sku.length <= 120 &&
        typeof partRequest.quantity === 'number' &&
        Number.isInteger(partRequest.quantity) &&
        Number(partRequest.quantity) >= 1 &&
        Number(partRequest.quantity) <= 1000;
      if (typeof ticketId !== 'string' || !body ||
          Object.keys(body).some((key) => !['benchPartnerId', 'partRequest'].includes(key)) ||
          (!('benchPartnerId' in body) && !('partRequest' in body)) ||
          ('benchPartnerId' in body &&
            body.benchPartnerId !== null &&
            (typeof body.benchPartnerId !== 'string' ||
              body.benchPartnerId.trim().length === 0 ||
              body.benchPartnerId.length > 120)) ||
          ('partRequest' in body && !validPartRequest)) {
        response.status(400).json({ message: 'Provide a valid partner assignment or inventory part request.' });
        return;
      }
      if (!operationsDirectory?.updateRepairWorkshop) {
        response.status(503).json({ message: 'The repair workshop integration is unavailable.' });
        return;
      }
      try {
        const repair = await operationsDirectory.updateRepairWorkshop(
          ticketId,
          {
            ...('benchPartnerId' in body
              ? { benchPartnerId: body.benchPartnerId as string | null }
              : {}),
            ...(validPartRequest
              ? {
                  partRequest: {
                    sku: partRequest.sku.trim(),
                    quantity: Number(partRequest.quantity),
                  },
                }
              : {}),
          },
          request.authUser!,
        );
        await store.recordAudit(
          request.authUser!,
          'repair.workshop_updated',
          'repair_ticket',
          repair.ticketNumber,
          {
            id: repair.id,
            partnerId: 'benchPartnerId' in body ? body.benchPartnerId as string | null : null,
            partRequested: validPartRequest,
          },
        );
        response.json({ repair });
      } catch (error) {
        const statusCode = error instanceof Error && 'statusCode' in error
          ? error.statusCode
          : undefined;
        if (typeof statusCode === 'number' && [400, 404, 409].includes(statusCode)) {
          response.status(statusCode).json({
            message: error instanceof Error ? error.message : 'Workshop details could not be updated.',
          });
          return;
        }
        throw error;
      }
    },
  );

  router.patch(
    '/admin/operations/repairs/:ticketId/stage',
    authenticate,
    requirePermission(access, 'repair', 'edit'),
    async (request, response): Promise<void> => {
      const ticketId = request.params['ticketId'];
      const body = request.body as Record<string, unknown> | undefined;
      const validStages = ['received', 'diagnosis', 'quote_approval', 'repairing', 'qc_passed', 'delivered'];
      if (typeof ticketId !== 'string' || !body ||
          Object.keys(body).some((key) => !['stage', 'remarks', 'estimatedCost', 'quoteApproved', 'parts', 'benchPartnerId', 'benchPartnerName'].includes(key)) ||
          typeof body.stage !== 'string' || !validStages.includes(body.stage) ||
          (body.remarks !== undefined &&
            (typeof body.remarks !== 'string' || body.remarks.length > 500))) {
        response.status(400).json({ message: 'A valid repair stage and an optional note of at most 500 characters are required.' });
        return;
      }
      if (!operationsDirectory?.transitionRepairStage) {
        response.status(503).json({ message: 'The repair workflow service is unavailable.' });
        return;
      }
      try {
        const repair = await operationsDirectory.transitionRepairStage(
          ticketId,
          body.stage,
          typeof body.remarks === 'string' ? body.remarks.trim() : '',
          body,
          request.authUser!,
        );
        await store.recordAudit(
          request.authUser!,
          'repair.stage_changed',
          'repair_ticket',
          repair.ticketNumber,
          { id: repair.id, fromStatus: repair.fromStatus, stage: repair.stage, status: repair.status },
        );
        response.json({ repair });
      } catch (error) {
        const statusCode = error instanceof Error && 'statusCode' in error
          ? error.statusCode
          : undefined;
        if (typeof statusCode === 'number' && [400, 404, 409].includes(statusCode)) {
          response.status(statusCode).json({
            message: error instanceof Error ? error.message : 'The repair stage could not be changed.',
          });
          return;
        }
        throw error;
      }
    },
  );

  router.post('/auth/login', async (request, response): Promise<void> => {
    const body = request.body as Record<string, unknown> | undefined;
    if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
      response.status(400).json({ message: 'Email and password are required.' });
      return;
    }
    if (body.email.trim().length === 0 || body.email.length > 254 ||
        body.password.length === 0 || body.password.length > 200) {
      response.status(400).json({ message: 'Email or password is invalid.' });
      return;
    }
    const user = await authentication.authenticate(body.email, body.password, request.ip ?? 'unknown');
    if (!user) {
      response.status(401).json({ message: 'Invalid email or password.' });
      return;
    }

    const session = await sessions.create(user.id);
    response.json({
      user: await access.sessionUser(user),
      expiresAt: session.expiresAt,
      impersonation: null,
      sessionToken: session.id,
    });
  });

  router.get('/auth/me', async (request, response): Promise<void> => {
    const credential = readSessionCredential(request.headers.cookie, request.headers.authorization);
    const sessionId = credential.sessionId;
    const session = sessionId ? await sessions.get(sessionId) : undefined;
    const user = session ? await store.getUserById(session.userId) : undefined;
    if (!sessionId || !session || !user || user.disabled ||
        (session.impersonatedBy && user.role === 'superadmin')) {
      if (sessionId && session) await sessions.revoke(sessionId);
      response.json({ user: null, expiresAt: null });
      return;
    }
    let impersonation: { actorId: string; actorName: string; actorEmail: string } | null = null;
    if (session.impersonatedBy) {
      const actor = await store.getUserById(session.impersonatedBy.id);
      if (!actor || actor.disabled || actor.role !== 'superadmin' ||
          !(await access.can(actor, 'users', 'view')) ||
          !(await access.can(actor, 'users', 'edit'))) {
        await sessions.revoke(sessionId);
        response.json({ user: null, expiresAt: null });
        return;
      }
      impersonation = {
        actorId: session.impersonatedBy.id,
        actorName: session.impersonatedBy.name,
        actorEmail: session.impersonatedBy.email,
      };
    }
    response.json({
      user: await access.sessionUser(user),
      expiresAt: session.expiresAt,
      impersonation,
    });
  });

  router.post(
    '/auth/impersonation/exchange',
    async (request, response): Promise<void> => {
      const body = request.body as Record<string, unknown> | undefined;
      if (!body || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(body.token)) {
        response.status(400).json({ message: 'A valid one-time launch token is required.' });
        return;
      }
      const launch = await sessions.consumeImpersonationLaunch(body.token);
      if (!launch) {
        response.status(401).json({ message: 'This user-panel link is invalid or has expired.' });
        return;
      }
      const actor = await store.getUserById(launch.actorId);
      const target = await store.getUserById(launch.targetId);
      if (!actor || actor.disabled || actor.role !== 'superadmin' ||
          !(await access.can(actor, 'users', 'view')) ||
          !(await access.can(actor, 'users', 'edit'))) {
        response.status(403).json({ message: 'The Superadmin no longer has permission to open user panels.' });
        return;
      }
      if (!target || target.disabled || target.role === 'superadmin' || target.id === actor.id) {
        response.status(403).json({ message: 'This account cannot be opened as a user panel.' });
        return;
      }
      let session;
      try {
        session = await sessions.createImpersonationSession(
          target.id,
          { id: actor.id, name: actor.name, email: actor.email },
          launch.actorSessionHash,
        );
      } catch (error) {
        if (!(error instanceof InvalidSessionError)) throw error;
        response.status(401).json({ message: 'The Superadmin session is no longer valid.' });
        return;
      }
      await store.recordAudit(actor, 'auth.impersonation_started', 'user', target.id, {
        impersonatedUserEmail: target.email,
        reason: launch.reason,
        actorSessionId: launch.actorSessionHash,
        sessionId: sessions.auditReference(session.id),
        sourceIp: request.ip ?? null,
        userAgent: request.get('user-agent') ?? null,
        expiresInMinutes: 30,
      });
      response.json({
        sessionToken: session.id,
        user: await access.sessionUser(target),
        expiresAt: session.expiresAt,
        impersonation: {
          actorId: actor.id,
          actorName: actor.name,
          actorEmail: actor.email,
        },
      });
    },
  );

  router.patch('/auth/profile', authenticate, async (request, response): Promise<void> => {
    const input = parseProfileInput(request.body);
    if (!input) {
      response.status(400).json({ message: 'A name and phone number are required.' });
      return;
    }
    if (input.completeSetup && request.authSession?.impersonatedBy) {
      response.status(403).json({ message: 'Admin profile setup must be completed from the assigned account.' });
      return;
    }
    try {
      const user = await access.updateProfile(request.authUser!, input);
      response.json({ user: await access.sessionUser(user) });
    } catch (error) {
      sendServiceError(response, error);
    }
  });

  router.get('/auth/profile/company', authenticate, async (_request, response): Promise<void> => {
    response.json({ companyProfile: await store.getCompanyProfile() });
  });

  router.patch(
    '/auth/profile/company',
    authenticate,
    requirePermission(access, 'settings', 'edit'),
    async (request, response): Promise<void> => {
      const input = parseCompanyProfileInput(request.body);
      if (!input) {
        response.status(400).json({ message: 'Enter a valid company name, phone, email, and GSTIN.' });
        return;
      }
      response.json({ companyProfile: await store.updateCompanyProfile(input, request.authUser!) });
    },
  );

  router.post('/auth/profile/password', authenticate, async (request, response): Promise<void> => {
    if (request.authSession?.impersonatedBy) {
      response.status(403).json({ message: 'Password changes are unavailable while viewing another account.' });
      return;
    }
    const input = parsePasswordInput(request.body);
    if (!input) {
      response.status(400).json({ message: 'Current and new passwords are required.' });
      return;
    }
    const currentSessionId = request.authSessionId;
    if (!currentSessionId) {
      response.status(401).json({ message: 'Authentication required.' });
      return;
    }
    try {
      await authentication.changePassword(
        request.authUser!,
        input.currentPassword,
        input.newPassword,
      );
    } catch (error) {
      if (error instanceof PasswordChangeError) {
        response.status(400).json({ message: error.message });
        return;
      }
      throw error;
    }
    await sessions.revokeOtherSessions(request.authUser!.id, currentSessionId);
    response.status(204).end();
  });

  router.put(
    '/auth/profile/avatar',
    authenticate,
    express.raw({
      type: ['image/jpeg', 'image/png', 'image/webp'],
      limit: '512kb',
    }),
    async (request, response): Promise<void> => {
      const contentType = request.get('content-type')?.split(';', 1)[0];
      if (!Buffer.isBuffer(request.body) ||
          (contentType !== 'image/jpeg' && contentType !== 'image/png' && contentType !== 'image/webp')) {
        response.status(400).json({ message: 'Upload a JPEG, PNG, or WebP profile photo.' });
        return;
      }
      try {
        const user = await store.updateAvatar(
          request.authUser!.id,
          { contentType, bytes: request.body },
          request.authUser!,
        );
        if (!user) {
          response.status(404).json({ message: 'User not found.' });
          return;
        }
        response.json({ user: await access.sessionUser(user) });
      } catch (error) {
        if (error instanceof InvalidProfileImageError) {
          response.status(400).json({ message: error.message });
          return;
        }
        throw error;
      }
    },
  );

  router.get('/auth/profile/avatar', authenticate, async (request, response): Promise<void> => {
    const avatar = await store.getAvatar(request.authUser!.id);
    if (!avatar) {
      response.status(404).json({ message: 'No profile photo is set.' });
      return;
    }
    response.setHeader('Content-Type', avatar.contentType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(avatar.bytes);
  });

  router.delete('/auth/profile/avatar', authenticate, async (request, response): Promise<void> => {
    const user = await store.updateAvatar(request.authUser!.id, null, request.authUser!);
    if (!user) {
      response.status(404).json({ message: 'User not found.' });
      return;
    }
    response.json({ user: await access.sessionUser(user) });
  });

  router.post('/auth/logout', authenticate, async (request, response): Promise<void> => {
    const user = request.authUser!;
    const sessionId = request.authSessionId;
    if (sessionId) await sessions.revoke(sessionId);
    const actorId = request.authSession?.impersonatedBy?.id;
    if (actorId) {
      const actor = await store.getUserById(actorId);
      if (actor) {
        await store.recordAudit(actor, 'auth.impersonation_ended', 'user', user.id, {
          targetUserEmail: user.email,
          sessionId: sessionId ? sessions.auditReference(sessionId) : null,
          sourceIp: request.ip ?? null,
          userAgent: request.get('user-agent') ?? null,
        });
      }
    }
    await authentication.recordLogout(user);
    response.status(204).end();
  });

  router.get(
    '/access/roles',
    authenticate,
    requirePermission(access, 'users', 'view'),
    requireSuperadmin,
    async (_request, response): Promise<void> => {
      response.json({ roles: ROLES, pages: PAGES, permissions: await store.getPermissions() });
    },
  );

  router.put(
    '/access/roles/:role',
    authenticate,
    requirePermission(access, 'users', 'edit'),
    requireSuperadmin,
    async (request, response): Promise<void> => {
      const role = request.params['role'];
      const body = request.body as Record<string, unknown> | undefined;
      if (!isRole(role) || !body || !validateRolePermissions(body.permissions)) {
        response.status(400).json({ message: 'A complete role permission matrix is required.' });
        return;
      }

      try {
        await access.updatePermissions(
          role,
          body.permissions as PermissionMatrix[Role],
          request.authUser!,
        );
        response.json({ permissions: await store.getPermissions() });
      } catch (error) {
        sendServiceError(response, error);
      }
    },
  );

  router.get(
    '/admin/users',
    authenticate,
    requirePermission(access, 'users', 'view'),
    async (_request, response): Promise<void> => {
      response.json({ users: (await store.listUsers()).map(publicUser) });
    },
  );

  router.post(
    '/admin/users/:id/impersonation',
    authenticate,
    requirePermission(access, 'users', 'view'),
    requirePermission(access, 'users', 'edit'),
    requireSuperadmin,
    async (request, response): Promise<void> => {
      const id = request.params['id'];
      if (typeof id !== 'string') {
        response.status(400).json({ message: 'A valid user id is required.' });
        return;
      }
      const actor = request.authUser!;
      const target = await store.getUserById(id);
      if (!target || target.disabled || target.role === 'superadmin' || target.id === actor.id) {
        response.status(403).json({ message: 'This account cannot be opened as a user panel.' });
        return;
      }
      const actorSessionId = request.authSessionId;
      if (!actorSessionId) {
        response.status(401).json({ message: 'Authentication required.' });
        return;
      }
      let launch;
      try {
        launch = await sessions.createImpersonationLaunch(
          actor.id,
          target.id,
          actorSessionId,
          IMPERSONATION_AUDIT_REASON,
        );
      } catch (error) {
        if (!(error instanceof InvalidSessionError)) throw error;
        response.status(401).json({ message: 'The Superadmin session is no longer valid.' });
        return;
      }
      await store.recordAudit(actor, 'auth.impersonation_link_created', 'user', target.id, {
        expiresInSeconds: 60,
        reason: IMPERSONATION_AUDIT_REASON,
        actorSessionId: sessions.auditReference(actorSessionId),
        sourceIp: request.ip ?? null,
        userAgent: request.get('user-agent') ?? null,
      });
      response.json({ launchToken: launch.token, expiresAt: launch.expiresAt });
    },
  );

  router.get(
    '/admin/registrations/:id',
    authenticate,
    requirePermission(access, 'directory', 'view'),
    async (request, response): Promise<void> => {
      if (!platformDirectory) {
        response.status(503).json({ message: 'The platform registration directory is unavailable.' });
        return;
      }
      const details = await platformDirectory.getRegistrationDetails(request.params['id']);
      if (!details) {
        response.status(404).json({ message: 'The registered account was not found.' });
        return;
      }
      response.json({ details });
    },
  );

  router.post(
    '/admin/registrations/:id/tracking-access',
    authenticate,
    requirePermission(access, 'directory', 'view'),
    async (request, response): Promise<void> => {
      if (!platformDirectory) {
        response.status(503).json({ message: 'The platform registration directory is unavailable.' });
        return;
      }
      const details = await platformDirectory.getRegistrationDetails(request.params['id']);
      if (!details || details.registration.app !== 'energy-hub') {
        response.status(404).json({ message: 'The partner account was not found.' });
        return;
      }
      await store.recordAudit(request.authUser!, 'livemonitor.tracking_profile_opened', 'registration',
        details.registration.id, {
          registrationId: details.registration.registrationId,
          currentJobReference: details.account.currentWork?.reference ?? null,
          liveLocationAvailable: Boolean(details.account.currentWork?.liveLocation),
        });
      response.json({ details });
    },
  );

  router.get(
    '/admin/registrations',
    authenticate,
    requirePermission(access, 'directory', 'view'),
    async (_request, response): Promise<void> => {
      if (!platformDirectory) {
        response.status(503).json({ message: 'The platform registration directory is unavailable.' });
        return;
      }
      response.json({ registrations: await platformDirectory.listRegistrations() });
    },
  );

  router.post(
    '/admin/users',
    authenticate,
    requirePermission(access, 'users', 'create'),
    async (request, response): Promise<void> => {
      const input = parseUserInput(request.body);
      if (!input) {
        response.status(400).json({ message: 'Name, email, password, and a valid role are required.' });
        return;
      }
      try {
        const user = await access.createUser(input, request.authUser!);
        response.status(201).json({ user: publicUser(user) });
      } catch (error) {
        sendServiceError(response, error);
      }
    },
  );

  router.get(
    '/admin/users/:id/permissions',
    authenticate,
    requirePermission(access, 'users', 'view'),
    requireSuperadmin,
    async (request, response): Promise<void> => {
      const id = request.params['id'];
      if (typeof id !== 'string') {
        response.status(400).json({ message: 'A valid user id is required.' });
        return;
      }
      const user = await store.getUserById(id);
      if (!user) {
        response.status(404).json({ message: 'User not found.' });
        return;
      }
      response.json({ permissions: user.permissions ?? null });
    },
  );

  router.put(
    '/admin/users/:id/permissions',
    authenticate,
    requirePermission(access, 'users', 'edit'),
    requireSuperadmin,
    async (request, response): Promise<void> => {
      const id = request.params['id'];
      const body = request.body as Record<string, unknown> | undefined;
      if (typeof id !== 'string' || !body ||
          (body.permissions !== null && !validateRolePermissions(body.permissions))) {
        response.status(400).json({
          message: 'Provide a complete permission matrix or null to inherit role access.',
        });
        return;
      }
      try {
        const permissions = body.permissions as PermissionMatrix[Role] | null;
        const user = await access.updateUserPermissions(id, permissions, request.authUser!);
        response.json({ user: publicUser(user), permissions: user.permissions ?? null });
      } catch (error) {
        sendServiceError(response, error);
      }
    },
  );

  router.patch(
    '/admin/users/:id',
    authenticate,
    requirePermission(access, 'users', 'edit'),
    async (request, response): Promise<void> => {
      const input = parseUserUpdate(request.body);
      if (!input) {
        response.status(400).json({ message: 'A valid role and disabled state are required.' });
        return;
      }
      const id = request.params['id'];
      if (typeof id !== 'string') {
        response.status(400).json({ message: 'A valid user id is required.' });
        return;
      }
      try {
        const user = await access.updateUser(id, input, request.authUser!);
        response.json({ user: publicUser(user) });
      } catch (error) {
        sendServiceError(response, error);
      }
    },
  );

  router.delete(
    '/admin/users/:id',
    authenticate,
    requirePermission(access, 'users', 'delete'),
    requireSuperadmin,
    async (request, response): Promise<void> => {
      const id = request.params['id'];
      if (typeof id !== 'string') {
        response.status(400).json({ message: 'A valid user id is required.' });
        return;
      }
      try {
        await access.deleteUser(id, request.authUser!);
        await sessions.revokeUserAccess(id);
        response.status(204).end();
      } catch (error) {
        sendServiceError(response, error);
      }
    },
  );

  router.get(
    '/admin/audit',
    authenticate,
    requirePermission(access, 'activity', 'view'),
    async (_request, response): Promise<void> => {
      const events: AuditEvent[] = await store.listAuditEvents();
      response.json({ events });
    },
  );

  return router;
}
