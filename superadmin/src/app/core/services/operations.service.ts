import { inject, Injectable, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { AdminApiService, type OperationAssignment } from './admin-api.service';
import { AuthService } from './auth.service';
import type { PageKey } from '../models/user.model';

export type JobStatus = 'unassigned' | 'progress' | 'completed' | 'sla-risk';
export type JobPriority = 'low' | 'normal' | 'high' | 'critical';
export type JobStage = 'triage' | 'assigned' | 'scheduled' | 'on-site' | 'in-service' | 'quality-check';
export type DisputeStatus = 'open' | 'investigating' | 'resolved';
export type InvoiceType = 'customer' | 'partner';
export type InvoiceStatus = 'paid' | 'unpaid' | 'overdue';
export type ProjectStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'clarification_required'
  | 'approved'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export interface ProjectMilestone {
  id: string;
  title: string;
  sequence: number;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  plannedStart: string | null;
  dueDate: string;
  completedAt: string | null;
  clientSignoffStatus: 'not_required' | 'pending' | 'approved' | 'rejected';
  leadEngineerName: string | null;
  budgetAmount: number | null;
  materialCost: number | null;
  partnerPayout: number | null;
  billedAmount: number | null;
}

export interface ProjectStatusHistory {
  oldStatus: string | null;
  newStatus: string;
  note: string | null;
  changedAt: string;
}

export interface JobActivity {
  at: string;
  title: string;
  detail: string;
}

export interface JobStageHistory {
  at: string;
  fromStage: string | null;
  toStage: string | null;
  note: string | null;
}

export interface JobChecklistItem {
  id: string;
  label: string;
  done: boolean;
}

export interface Job {
  id: string;
  company: string;
  service: string;
  partner: string | null;
  status: JobStatus;
  slaMinsLeft: number | null;
  amount: number;
  site: string;
  companyAmc?: 'active' | 'expiring' | 'none';
  companySiteCount?: number | null;
  jobType?: string;
  targetRole?: string;
  partnerId?: string | null;
  amountSource?: string | null;
  category?: string;
  priority?: JobPriority;
  requester?: string;
  contactPhone?: string;
  siteAddress?: string;
  asset?: string;
  issue?: string;
  workScope?: string;
  estimatedHours?: number;
  notes?: string;
  createdAt?: string;
  scheduledAt?: string;
  assignedAt?: string;
  slaDueAt?: string | null;
  completedAt?: string | null;
  rawStage?: string | null;
  totalBill?: number | null;
  payoutAmount?: number | null;
  partsTotal?: number | null;
  beforePhotoCount?: number;
  afterPhotoCount?: number;
  liveLocation?: { latitude: number; longitude: number; updatedAt: string | null } | null;
  lastLocationAt?: string | null;
  stageHistory?: JobStageHistory[];
  latitude?: number | null;
  longitude?: number | null;
  stage?: JobStage;
  checklist?: JobChecklistItem[];
  workNotes?: JobActivity[];
  activity?: JobActivity[];
}

export interface Partner {
  id: string;
  name: string;
  type: 'service' | 'repairing' | 'panelmaker' | 'supplier';
  rating: number;
  jobsDone: number;
  experienceYears?: string | null;
  online: boolean;
  busy?: boolean;
  verified: boolean;
  city: string;
  lastLocationAt?: string | null;
  specializations?: string[];
}

export function jobSkillMatchCount(job: Job, partner: Partner): number {
  const jobText = [job.category, job.service, job.issue, job.asset]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
  if (!jobText) return 0;
  return (partner.specializations ?? []).filter((specialization) => {
    const value = specialization.trim().toLocaleLowerCase();
    if (!value) return false;
    return jobText.includes(value) ||
      value.split(/[^a-z0-9]+/).some((term) => term.length >= 4 && jobText.includes(term));
  }).length;
}

export interface VerificationRequest {
  id: string;
  name: string;
  type: string;
  documents: string[];
  appliedAt: string;
}

export interface Dispute {
  id: string;
  job: string;
  partner: string;
  reason: string;
  status: DisputeStatus;
  openedAt: string;
  amount: number;
}

export interface Company {
  id?: string;
  name: string;
  gst: string;
  sites: number;
  users: number;
  amc: string;
  totalJobs: number;
  revenue: number;
  lastActivityAt?: string | null;
}

export interface AmcContract {
  id: string;
  company: string;
  plan: string;
  expires: string;
  daysLeft: number;
  compliance: string;
  value: number | null;
}

export interface Payout {
  id: string;
  partner: string;
  period: string;
  jobs: number;
  amount: number;
  status: 'pending' | 'paid';
}

export interface Invoice {
  id: string;
  type: InvoiceType;
  party: string;
  amount: number;
  status: InvoiceStatus;
  due: string;
}

export interface InventoryItem {
  sku: string;
  name: string;
  category: string;
  stock: number;
  low: number;
  supplier: string | null;
}

export interface RepairTicket {
  id: string;
  ticketNumber: string;
  device: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  assetNumber: string;
  location: string;
  clientName: string;
  siteName: string;
  amcStatus: string;
  amcEndDate: string | null;
  partner: string | null;
  stage: 'draft' | 'received' | 'diagnosis' | 'quote_approval' | 'repairing' | 'qc_passed' | 'delivered' | 'cancelled';
  status: string;
  fault: string;
  symptoms: string;
  serviceType: string;
  repairScope: string;
  priority: string;
  requestedTurnaround: string;
  inAt: string;
  updatedAt: string | null;
  completedAt: string | null;
  cost: number | null;
  estimateRequired: boolean;
  quoteApproved: boolean;
  spareParts: Array<{ sku: string; name: string; quantity: number }>;
  partRequests: Array<{
    sku: string;
    name: string;
    quantity: number;
    status: 'requested' | 'issued';
    requestedAt: string;
  }>;
  benchPartnerId: string | null;
  benchPartnerName: string | null;
  diagnosisAt: string | null;
  testRecord: boolean;
  history: Array<{ status: string; remarks: string; at: string | null }>;
}

export interface ProjectRequest {
  id: string;
  requestId: string;
  company: string;
  title: string;
  panels: string;
  status: ProjectStatus;
  eta: string;
  value: number | null;
  currency: string;
  site: string;
  category: string;
  projectType: string;
  description: string;
  requirements: string;
  createdAt: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  details: Record<string, string | null>;
  milestones: ProjectMilestone[];
  statusHistory: ProjectStatusHistory[];
}

type SourceStatus = 'unknown' | 'loading' | 'connected' | 'not-connected' | 'error';

interface OperationsResponse<T> {
  items: T[];
  sourceStatus: 'connected' | 'not-connected';
  message?: string;
  insights?: AnalyticsInsights;
}

interface JobsResponse {
  jobs: Job[];
  partners: Partner[];
  sourceStatus: 'connected' | 'not-connected';
}

export interface AnalyticsEvent {
  id: string;
  at: string;
  activityAt: string;
  revenueAt: string | null;
  amount: number;
  grossRevenue: number;
  refundAmount: number;
  refundAt: string | null;
  payoutAmount: number;
  pendingPayout: number;
  paidPayout: number;
  payoutAt: string | null;
  category: 'SVC' | 'REP' | 'PANEL' | 'DEL' | 'AMC' | 'ORDERS' | 'OTHER';
  kind: string;
  status: string;
  completedAt: string | null;
  assignedAt?: string | null;
  slaDueAt: string | null;
  slaBreachAt: string | null;
  slaBreached: boolean | null;
  delayMinutes: number | null;
  mttrMinutes: number | null;
  dispatchMinutes: number | null;
  partnerId: string | null;
  partnerName: string | null;
  partnerRating: number | null;
  activeAmc: boolean | null;
  issue: string | null;
  oem: string | null;
  expiresAt?: string | null;
  estimatedBudget?: number | null;
}

export interface AnalyticsInsights {
  pendingPayouts: number;
  activeAmcContracts: number;
  expiringAmcContracts: number;
  openAmcRequests: number;
  recurringAmcValue: number | null;
  recurringAmcValueAvailable: boolean;
  invoiceDataAvailable: boolean;
  taxDataAvailable: boolean;
  lowStockItems: Array<{
    id: string;
    name: string;
    sku: string;
    quantity: number;
    reorderLevel: number;
    recentJobsUsing: number;
  }>;
}

const EMPTY_ANALYTICS_INSIGHTS: AnalyticsInsights = {
  pendingPayouts: 0,
  activeAmcContracts: 0,
  expiringAmcContracts: 0,
  openAmcRequests: 0,
  recurringAmcValue: null,
  recurringAmcValueAvailable: false,
  invoiceDataAvailable: false,
  taxDataAvailable: false,
  lowStockItems: [],
};

function istDateParts(value: string | Date): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(typeof value === 'string' ? new Date(value) : value);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour') };
}

interface PartnerRoleCount {
  type: Partner['type'];
  count: number;
}

@Injectable({ providedIn: 'root' })
export class OperationsService {
  private readonly api = inject(AdminApiService);
  private readonly auth = inject(AuthService);
  private started = false;
  private readonly _companies = signal<Company[]>([]);
  private readonly _amcs = signal<AmcContract[]>([]);
  private readonly _inventory = signal<InventoryItem[]>([]);
  private readonly analyticsEvents = signal<AnalyticsEvent[]>([]);
  private readonly _analyticsInsights = signal<AnalyticsInsights>(EMPTY_ANALYTICS_INSIGHTS);
  private readonly sourceStatuses = signal<Record<string, SourceStatus>>({});
  readonly loadErrors = signal<Record<string, string>>({});
  readonly jobs = signal<Job[]>([]);
  readonly partners = signal<Partner[]>([]);
  readonly jobsLastSyncedAt = signal<string | null>(null);
  readonly partnerRoleCounts = signal<PartnerRoleCount[]>([]);
  readonly verifications = signal<VerificationRequest[]>([]);
  readonly disputes = signal<Dispute[]>([]);
  readonly payouts = signal<Payout[]>([]);
  readonly invoices = signal<Invoice[]>([]);
  readonly repairs = signal<RepairTicket[]>([]);
  readonly projects = signal<ProjectRequest[]>([]);

  get operationErrors(): Array<[string, string]> {
    return Object.entries(this.loadErrors());
  }

  get companies(): Company[] {
    return this._companies();
  }

  get amcs(): AmcContract[] {
    return this._amcs();
  }

  get inventory(): InventoryItem[] {
    return this._inventory();
  }

  get revenueTrend(): Array<{ label: string; value: number }> {
    const now = istDateParts(new Date());
    const months = Array.from({ length: 6 }, (_, index) => {
      const month = new Date(Date.UTC(now.year, now.month - 1 - 5 + index, 1));
      const year = month.getUTCFullYear();
      const monthNumber = month.getUTCMonth() + 1;
      return {
        key: `${year}-${String(monthNumber).padStart(2, '0')}`,
        label: new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' }).format(month),
        value: 0,
      };
    });
    for (const event of this.analyticsEvents()) {
      if (!event.revenueAt) continue;
      const date = istDateParts(event.revenueAt);
      const point = months.find((month) =>
        month.key === `${date.year}-${String(date.month).padStart(2, '0')}`,
      );
      if (point && event.category === 'SVC') point.value += event.grossRevenue;
    }
    return months;
  }

  get peakHours(): Array<{ label: string; value: number }> {
    const ranges = [
      { label: '8-10', start: 8, end: 10 },
      { label: '10-12', start: 10, end: 12 },
      { label: '12-14', start: 12, end: 14 },
      { label: '14-16', start: 14, end: 16 },
      { label: '16-18', start: 16, end: 18 },
      { label: '18-20', start: 18, end: 20 },
    ];
    const events = this.analyticsEvents();
    return ranges.map((range) => ({
      label: range.label,
      value: events.filter((event) => event.kind !== 'earning').filter((event) => {
        const hour = istDateParts(event.activityAt).hour;
        return hour >= range.start && hour < range.end;
      }).length,
    }));
  }

  get categoryRevenue(): Array<{ label: string; value: number }> {
    const labels: Record<AnalyticsEvent['category'], string> = {
      SVC: 'Service',
      REP: 'Repairs',
      PANEL: 'Panels & projects',
      DEL: 'Delivery',
      AMC: 'AMC',
      ORDERS: 'Orders',
      OTHER: 'Unmapped',
    };
    const totals = new Map<AnalyticsEvent['category'], number>();
    for (const event of this.analyticsEvents()) {
      totals.set(event.category, (totals.get(event.category) ?? 0) + event.grossRevenue);
    }
    return [...totals].map(([category, value]) => ({ label: labels[category], value }));
  }

  loadAuthorizedData(): void {
    if (this.started) return;
    this.started = true;
    const domains: Array<{ domain: string; page: PageKey }> = [
      { domain: 'jobs', page: 'jobs' },
      { domain: 'livemonitor', page: 'livemonitor' },
      { domain: 'partner-app', page: 'partner-app' },
      { domain: 'verification', page: 'verification' },
      { domain: 'disputes', page: 'disputes' },
      { domain: 'companies', page: 'companies' },
      { domain: 'amc', page: 'amc' },
      { domain: 'finance', page: 'finance' },
      { domain: 'invoices', page: 'invoices' },
      { domain: 'inventory', page: 'inventory' },
      { domain: 'repair', page: 'repair' },
      { domain: 'projects', page: 'projects' },
      { domain: 'analytics', page: 'analytics' },
    ];
    const permitted = domains.filter(({ page }) => this.auth.canAccess(page));
    const hasJobsAccess = permitted.some(({ domain }) => domain === 'jobs');
    void Promise.all(permitted
      .filter(({ domain }) => !(domain === 'livemonitor' && hasJobsAccess))
      .map(({ domain }) => this.loadDomain(domain)));
  }

  sourceStatus(domain: string): SourceStatus {
    return this.sourceStatuses()[domain] ?? 'unknown';
  }

  analyticsRecords(): AnalyticsEvent[] {
    return this.analyticsEvents();
  }

  analyticsInsights(): AnalyticsInsights {
    return this._analyticsInsights();
  }

  private async loadDomain(domain: string): Promise<boolean> {
    const syncedDomains = domain === 'jobs' || domain === 'livemonitor'
      ? ['jobs', 'livemonitor']
      : [domain];
    this.sourceStatuses.update((statuses) =>
      syncedDomains.reduce((next, key) => ({ ...next, [key]: 'loading' }), statuses),
    );
    try {
      if (domain === 'jobs' || domain === 'livemonitor') {
        const result = await this.api.getOperations<JobsResponse>(domain);
        this.jobs.set(result.jobs);
        this.partners.set(result.partners);
        this.jobsLastSyncedAt.set(new Date().toISOString());
        this.sourceStatuses.update((statuses) => ({
          ...statuses,
          jobs: result.sourceStatus,
          livemonitor: result.sourceStatus,
        }));
        this.loadErrors.update((errors) => {
          const next = { ...errors };
          for (const key of syncedDomains) delete next[key];
          return next;
        });
        return true;
      }
      if (domain === 'partner-app') {
        const result = await this.api.getOperations<OperationsResponse<PartnerRoleCount>>(domain);
        this.partnerRoleCounts.set(result.items);
        this.sourceStatuses.update((statuses) => ({ ...statuses, [domain]: result.sourceStatus }));
        return true;
      }
      if (domain === 'analytics') {
        const result = await this.api.getOperations<OperationsResponse<AnalyticsEvent>>(domain);
        this.analyticsEvents.set(result.items);
        this._analyticsInsights.set(result.insights ?? EMPTY_ANALYTICS_INSIGHTS);
        this.sourceStatuses.update((statuses) => ({ ...statuses, analytics: result.sourceStatus }));
        return true;
      }
      const result = await this.api.getOperations<OperationsResponse<
        VerificationRequest | Dispute | Company | AmcContract | Payout | Invoice |
        InventoryItem | RepairTicket | ProjectRequest
      >>(domain);
      this.sourceStatuses.update((statuses) => ({ ...statuses, [domain]: result.sourceStatus }));
      if (domain === 'verification') this.verifications.set(result.items as VerificationRequest[]);
      if (domain === 'disputes') this.disputes.set(result.items as Dispute[]);
      if (domain === 'companies') this._companies.set(result.items as Company[]);
      if (domain === 'amc') this._amcs.set(result.items as AmcContract[]);
      if (domain === 'finance') this.payouts.set(result.items as Payout[]);
      if (domain === 'invoices') this.invoices.set(result.items as Invoice[]);
      if (domain === 'inventory') this._inventory.set(result.items as InventoryItem[]);
      if (domain === 'repair') this.repairs.set(result.items as RepairTicket[]);
      if (domain === 'projects') this.projects.set(result.items as ProjectRequest[]);
      return true;
    } catch (error) {
      const message = error instanceof HttpErrorResponse && typeof error.error?.message === 'string'
        ? error.error.message
        : error instanceof Error ? error.message : 'Operations data could not be loaded.';
      this.sourceStatuses.update((statuses) =>
        syncedDomains.reduce((next, key) => ({ ...next, [key]: 'error' }), statuses),
      );
      this.loadErrors.update((errors) =>
        syncedDomains.reduce((next, key) => ({ ...next, [key]: message }), errors),
      );
      console.error(`Unable to load Superadmin operations data for ${domain}.`, error);
      return false;
    }
  }

  /* -------- dashboard aggregates -------- */
  readonly liveJobs = () => this.jobs().filter((job) => job.status !== 'completed');
  readonly unassignedJobs = () => this.liveJobs().filter((job) => job.status === 'unassigned');
  readonly inProgressJobs = () => this.liveJobs().filter((job) => job.status === 'progress');
  readonly atRiskJobs = () => this.liveJobs().filter((job) =>
    job.slaMinsLeft !== null && job.slaMinsLeft > 0 && job.slaMinsLeft <= 60,
  );
  readonly slaRiskJobs = () => this.jobs().filter((j) => j.status === 'sla-risk');
  readonly partnersOnline = () => this.partners().filter((p) => p.online);
  readonly pendingApprovals = () => this.verifications().length;
  readonly openDisputes = () => this.disputes().filter((d) => d.status !== 'resolved');
  readonly pendingPayouts = () => this.payouts().filter((p) => p.status === 'pending');
  readonly pendingPayoutTotal = () => this.pendingPayouts().reduce((n, p) => n + p.amount, 0);
  readonly monthRevenue = () => this.revenueTrend.at(-1)?.value ?? 0;
  readonly todayServiceEarnings = () => {
    const currentDay = istDateParts(new Date());
    const today = `${currentDay.year}-${String(currentDay.month).padStart(2, '0')}-${String(currentDay.day).padStart(2, '0')}`;
    return this.analyticsEvents()
      .filter((event) => {
        if (event.category !== 'SVC' || !event.revenueAt) return false;
        const parts = istDateParts(event.revenueAt);
        return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}` === today;
      })
      .reduce((total, event) => total + event.grossRevenue, 0);
  };
  readonly lowStockItems = () => this.inventory.filter((i) => i.stock <= i.low);
  readonly inventorySuppliers = () =>
    new Set(this.inventory.map((item) => item.supplier).filter((supplier) => supplier && supplier !== '—')).size;
  readonly activeRepairs = () =>
    this.repairs().filter((ticket) => !['delivered', 'cancelled', 'draft'].includes(ticket.stage));
  readonly expiringAmcs = () => this.amcs.filter((a) => a.daysLeft <= 30);

  /* -------- actions (superadmin workflows) -------- */

  async refreshOperations(domain?: 'jobs' | 'livemonitor' | 'repair'): Promise<boolean> {
    return this.loadDomain(domain ?? (this.auth.canAccess('jobs') ? 'jobs' : 'livemonitor'));
  }

  async assignJob(jobId: string, partnerId: string | null): Promise<{ assignment: OperationAssignment; refreshed: boolean }> {
    const assignment = await this.api.assignOperationJob(jobId, partnerId);
    const at = new Date().toISOString();
    const partner = partnerId ? this.partners().find((item) => item.id === partnerId) ?? null : null;
    this.jobs.update((list) =>
      list.map((job) => {
        if (job.id !== jobId || job.status === 'completed' || !assignment.changed) return job;
        const partnerName = partner?.name ?? assignment.partnerName ?? null;
        const title = partnerId ? (job.partner ? 'Partner reassigned' : 'Partner assigned') : 'Partner unassigned';
        const detail = partnerId
          ? `${partnerName ?? 'Selected partner'} is assigned to this job.`
          : `${job.partner ?? 'The assigned partner'} was removed from this job.`;
        return {
          ...job,
          partner: partnerName,
          partnerId,
          stage: partnerId ? 'assigned' : 'triage',
          status: job.slaMinsLeft !== null && job.slaMinsLeft <= 0
            ? 'sla-risk'
            : partnerId ? 'progress' : 'unassigned',
          assignedAt: assignment.assignedAt ?? (partnerId ? at : undefined),
          activity: [...(job.activity ?? []), { at, title, detail }],
        };
      }),
    );
    if (partnerId) {
      this.partners.update((list) => list.map((item) =>
        item.id === partnerId ? { ...item, busy: true } : item,
      ));
    }
    return { assignment, refreshed: await this.refreshOperations() };
  }

  async transitionRepairStage(
    id: string,
    stage: RepairTicket['stage'],
    remarks: string,
    details?: {
      estimatedCost?: number;
      quoteApproved?: boolean;
      parts?: Array<{ sku: string; name: string; quantity: number }>;
      benchPartnerId?: string;
      benchPartnerName?: string;
    },
  ): Promise<boolean> {
    await this.api.transitionRepairStage(id, stage, remarks, details);
    return this.loadDomain('repair');
  }

  async loadProjects(): Promise<boolean> {
    return this.loadDomain('projects');
  }

  approvePartner(id: string): void {
    this.verifications.update((list) => list.filter((v) => v.id !== id));
  }

  rejectPartner(id: string): void {
    this.verifications.update((list) => list.filter((v) => v.id !== id));
  }

  resolveDispute(id: string, resolution: DisputeStatus): void {
    this.disputes.update((list) => list.map((d) => (d.id === id ? { ...d, status: resolution } : d)));
  }

  markInvoicePaid(id: string): void {
    this.invoices.update((list) => list.map((i) => (i.id === id ? { ...i, status: 'paid' as const } : i)));
  }
}
