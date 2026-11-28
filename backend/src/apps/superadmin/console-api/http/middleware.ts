import type { RequestHandler } from 'express5';
import { AccessControlService } from '../services/access-control.js';
import { SessionManager } from '../services/sessions.js';
import { JsonStore } from '../infrastructure/json-store.js';
import { isPageKey, isPermissionAction, type PageKey, type PermissionAction } from '../domain/permissions.js';

const SESSION_COOKIE = 'eh_session';

export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  const pair = cookieHeader?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return pair?.slice(SESSION_COOKIE.length + 1);
}

export function readSessionCredential(
  cookieHeader: string | undefined,
  authorizationHeader: string | undefined,
): { sessionId: string | undefined; source: 'cookie' | 'bearer' } {
  if (authorizationHeader !== undefined) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorizationHeader.trim());
    return { sessionId: match?.[1], source: 'bearer' };
  }
  return { sessionId: readSessionCookie(cookieHeader), source: 'cookie' };
}

export function requireAuth(
  store: JsonStore,
  sessions: SessionManager,
  access: AccessControlService,
): RequestHandler {
  return async (request, response, next): Promise<void> => {
    const credential = readSessionCredential(request.headers.cookie, request.headers.authorization);
    const sessionId = credential.sessionId;
    const session = sessionId ? await sessions.get(sessionId) : undefined;
    const user = session ? await store.getUserById(session.userId) : undefined;
    if (!sessionId || !session || !user || user.disabled ||
        (session.impersonatedBy && user.role === 'superadmin')) {
      if (sessionId && session) await sessions.revoke(sessionId);
      response.status(401).json({ message: 'Authentication required.' });
      return;
    }
    if (session.impersonatedBy) {
      const actor = await store.getUserById(session.impersonatedBy.id);
      if (!actor || actor.disabled || actor.role !== 'superadmin' ||
          !(await access.can(actor, 'users', 'view')) ||
          !(await access.can(actor, 'users', 'edit'))) {
        await sessions.revoke(sessionId);
        response.status(401).json({ message: 'The Superadmin panel access session has expired.' });
        return;
      }
      request.authUser = { ...user, impersonatedBy: session.impersonatedBy };
    } else {
      request.authUser = user;
    }
    request.authSession = session;
    request.authSessionId = sessionId;
    request.authSessionSource = credential.source;
    next();
  };
}

export function requirePermission(
  access: AccessControlService,
  page: PageKey,
  action: PermissionAction,
): RequestHandler {
  return async (request, response, next): Promise<void> => {
    const user = request.authUser;
    if (!user) {
      response.status(401).json({ message: 'Authentication required.' });
      return;
    }
    if (!(await access.can(user, page, action))) {
      await access.recordDenied(user, page, action);
      response.status(403).json({ message: 'You do not have permission to perform this action.' });
      return;
    }
    next();
  };
}

export const requireSuperadmin: RequestHandler = (request, response, next) => {
  if (request.authUser?.role !== 'superadmin') {
    response.status(403).json({ message: 'Superadmin access required.' });
    return;
  }
  next();
};

export function isPageAndAction(page: unknown, action: unknown): boolean {
  return isPageKey(page) && isPermissionAction(action);
}
