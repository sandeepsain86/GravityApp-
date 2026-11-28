import { Router } from 'express5';
import { JsonStore } from './infrastructure/json-store.js';
import { PostgresStore } from './infrastructure/postgres-store.js';
import { AccessControlService } from './services/access-control.js';
import { AuthenticationService } from './services/authentication.js';
import { hashPassword } from './services/passwords.js';
import { SessionManager } from './services/sessions.js';
import type { SessionRepository } from './services/sessions.js';
import { createApiRouter } from './http/routes.js';
import { createRequire } from 'node:module';
import type { PlatformRegistration, PlatformRegistrationDetails } from './domain/models.js';

const require = createRequire(import.meta.url);
const { createPlatformDirectory } = require('./services/platform-directory.js') as {
  createPlatformDirectory: () => {
    listRegistrations(): Promise<PlatformRegistration[]>;
    getRegistrationDetails(id: string): Promise<PlatformRegistrationDetails | null>;
  };
};
const { createOperationsDirectory } = require('./services/operations-directory.js') as {
  createOperationsDirectory: () => {
    getData(domain: string): Promise<unknown>;
    assignJob(reference: string, partnerId: string | null, actor: import('./domain/models.js').StoredUser): Promise<{
      changed: boolean;
      jobId: string;
      reference: string;
      partnerId: string | null;
      partnerName?: string;
      assignedAt?: string;
    }>;
    transitionRepairStage(
      reference: string,
      stage: string,
      remarks: string,
      details: Record<string, unknown>,
      actor: import('./domain/models.js').StoredUser,
    ): Promise<{
      id: string;
      ticketNumber: string;
      status: string;
      stage: string;
      fromStatus: string;
      updatedAt: string;
    }>;
    updateRepairWorkshop(
      reference: string,
      changes: {
        benchPartnerId?: string | null;
        partRequest?: { sku: string; quantity: number };
      },
      actor: import('./domain/models.js').StoredUser,
    ): Promise<{
      id: string;
      ticketNumber: string;
      status: string;
      stage: string;
      fromStatus: string;
      updatedAt: string;
    }>;
    assignRepairPartnerToMany(
      references: string[],
      partnerId: string,
      actor: import('./domain/models.js').StoredUser,
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
    transitionProjectStatus(
      reference: string,
      status: string,
      note: string,
      actor: import('./domain/models.js').StoredUser,
    ): Promise<{ id: string; request_number: string; status: string; updated_at: string }>;
    createProjectMilestone(
      reference: string,
      input: Record<string, unknown>,
      actor: import('./domain/models.js').StoredUser,
    ): Promise<Record<string, unknown>>;
    updateProjectMilestone(
      reference: string,
      milestoneId: string,
      input: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
  };
};

export async function createSuperadminRouter(options: {
  bootstrap: { email: string; name: string; password: string };
  dataFile?: string;
  storage?: 'database';
  sessionRepository?: SessionRepository;
}): Promise<ReturnType<typeof Router>> {
  const { bootstrap, dataFile, storage = 'database', sessionRepository } = options;
  const credentials = bootstrap.password
    ? hashPassword(bootstrap.password)
    : { salt: '', hash: '' };
  let store: JsonStore;
  store = new PostgresStore(dataFile);
  await store.initialize({
    email: bootstrap.email,
    name: bootstrap.name,
    passwordSalt: credentials.salt,
    passwordHash: credentials.hash,
  });
  const sessions = new SessionManager(sessionRepository);
  await sessions.initialize();

  return createApiRouter({
    store,
    access: new AccessControlService(store),
    authentication: new AuthenticationService(store),
    sessions,
    secureCookies: process.env.NODE_ENV === 'production',
    platformDirectory: createPlatformDirectory(),
    operationsDirectory: createOperationsDirectory(),
  });
}
