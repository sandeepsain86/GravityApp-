import type { PermissionMatrix, Role, RolePermissions } from './permissions.js';

export interface StoredUser {
  id: string;
  userCode?: string;
  name: string;
  email: string;
  phone?: string | null;
  avatarFile?: string | null;
  avatarContentType?: 'image/jpeg' | 'image/png' | 'image/webp' | null;
  profileCompletedAt?: string | null;
  role: Role;
  disabled: boolean;
  permissions?: RolePermissions;
  permissionsAssignedBy?: { id: string; name: string; email: string } | null;
  passwordSalt: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  impersonatedBy?: { id: string; name: string; email: string };
}

export interface CompanyProfile {
  companyName: string;
  phone: string;
  email: string;
  gstin: string;
}

export interface SessionUser {
  id: string;
  userCode: string;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  profileSetupRequired: boolean;
  avatarInitials: string;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
  accessMode: 'role' | 'custom';
  permissionsAssignedBy: { name: string; email: string } | null;
  permissions: RolePermissions;
}

export interface AuditEvent {
  id: string;
  at: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, string | boolean | number | null>;
}

export interface PlatformRegistration {
  id: string;
  registrationId: string;
  app: 'energy-hub' | 'service-admin';
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  status: string;
  registeredAt: string | null;
  profile: {
    businessName: string | null;
    companyName: string | null;
    registeredAddress: string | null;
    serviceAreas: string[];
    specializations: string[];
    experienceYears: string | null;
    qualification: string | null;
    online: boolean | null;
    busy: boolean;
    completedServices: number;
    totalServices: number;
    totalEarnings: number | null;
    pendingEarnings: number | null;
    rating: number | null;
    ratingCount: number | null;
    ratings: Array<{ rating: number; service: string; at: string | null }>;
    latestService: {
      id: string;
      title: string;
      status: string;
      stage: string | null;
      location: string | null;
      scheduledAt: string | null;
      scheduledTime: string | null;
      slaDueAt: string | null;
      travelEtaMinutes: number | null;
      at: string | null;
    } | null;
  };
}

export interface RegistrationTimelineEntry {
  label: string;
  status: string;
  note: string | null;
  at: string | null;
}

export interface RegistrationActivity {
  id: string;
  kind: 'job' | 'service' | 'repair' | 'project' | 'amc';
  reference: string | null;
  title: string;
  status: string;
  priority: string | null;
  description: string | null;
  location: string | null;
  createdAt: string | null;
  scheduledAt: string | null;
  completedAt: string | null;
  dueAt: string | null;
  assignedTo: string | null;
  amount: number | null;
  currency: string | null;
  details: string[];
  timeline: RegistrationTimelineEntry[];
}

export interface RegistrationEarning {
  id: string;
  jobReference: string | null;
  source: string | null;
  gross: number;
  commission: number;
  deductions: number;
  net: number;
  status: string;
  createdAt: string | null;
  payoutAt: string | null;
}

export interface RegistrationOrder {
  id: string;
  orderNumber: string;
  status: string;
  currency: string;
  subtotal: number;
  deliveryFee: number;
  total: number;
  paymentMode: string | null;
  paymentStatus: string | null;
  paymentProvider: string | null;
  paymentAmount: number | null;
  createdAt: string | null;
  timeline: RegistrationTimelineEntry[];
}

export interface PlatformRegistrationDetails {
  registration: PlatformRegistration;
  account: {
    avatarUrl: string | null;
    secondaryPhone: string | null;
    emailVerified: boolean | null;
    phoneVerified: boolean | null;
    lastLoginAt: string | null;
    updatedAt: string | null;
    currentWork: {
      id: string;
      reference: string | null;
      title: string;
      stage: string;
      site: string | null;
      startedAt: string | null;
      checkedInAt: string | null;
      lastLocationUpdateAt: string | null;
      liveLocation: {
        latitude: number;
        longitude: number;
      } | null;
      distanceKm: number | null;
      travelEtaMinutes: number | null;
    } | null;
    partnerSince: string | null;
    travelRadiusKm: number | null;
    onboarding: {
      status: string | null;
      currentStep: number | null;
      submittedAt: string | null;
      rejectionReason: string | null;
    } | null;
    payoutProfileConfigured: boolean | null;
    vehicleVerification: {
      type: string;
      status: string;
      rejectionReason: string | null;
    } | null;
    companies: Array<{
      name: string;
      industry: string | null;
      location: string | null;
      status: string | null;
    }>;
    sites: Array<{
      name: string;
      address: string | null;
      city: string | null;
      type: string | null;
      status: string | null;
      primary: boolean;
      deviceCount: number;
    }>;
    devices: Array<{
      type: string | null;
      manufacturer: string | null;
      model: string | null;
      location: string | null;
      site: string | null;
      createdAt: string | null;
    }>;
    documents: Array<{
      type: string;
      status: string;
      uploadedAt: string | null;
      rejectionReason: string | null;
    }>;
  };
  activity: RegistrationActivity[];
  statusBreakdown: Array<{ status: string; count: number }>;
  monthlyActivity: Array<{ month: string; label: string; count: number; amount: number }>;
  financialSummary: {
    kind: 'payouts' | 'orders';
    total: number;
    paid: number;
    pending: number;
    failed: number;
    commission: number;
    deductions: number;
    count: number;
  };
  earnings: RegistrationEarning[];
  orders: RegistrationOrder[];
  supportRequests: Array<{
    subject: string;
    status: string;
    createdAt: string | null;
  }>;
}

export interface PersistentState {
  version: 1 | 2;
  users: StoredUser[];
  permissions: PermissionMatrix;
  auditEvents: AuditEvent[];
  companyProfile?: CompanyProfile;
}
