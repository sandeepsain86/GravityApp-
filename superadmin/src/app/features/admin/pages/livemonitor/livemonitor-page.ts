import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { interval } from 'rxjs';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import type { PlatformRegistrationDetails } from '../../../../core/models/user.model';
import { AdminChart } from '../../../../shared/admin-chart/admin-chart';
import {
  OperationsService,
  jobSkillMatchCount,
  type InventoryItem,
  type Job,
  type JobActivity,
  type Partner,
} from '../../../../core/services/operations.service';

type LiveJobFilter = 'all' | 'unassigned' | 'progress' | 'at-risk' | 'breached';
type JobTypeFilter = 'all' | 'service' | 'repair' | 'panel' | 'delivery';

@Component({
  selector: 'app-livemonitor-page',
  imports: [RouterLink, AdminChart],
  templateUrl: './livemonitor-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LivemonitorPage {
  readonly ops = inject(OperationsService);
  readonly auth = inject(AuthService);
  private readonly api = inject(AdminApiService);
  readonly jobFilter = signal<LiveJobFilter>('all');
  readonly jobTypeFilter = signal<JobTypeFilter>('all');
  readonly searchTerm = signal('');
  readonly highPriorityOnly = signal(false);
  readonly autoRefresh = signal(true);
  readonly isRefreshingJobs = signal(false);
  readonly jobPage = signal(1);
  readonly selectedJobIds = signal<string[]>([]);
  readonly selectedJobId = signal<string | null>(null);
  readonly assignmentPending = signal<Record<string, boolean>>({});
  readonly assignmentMessage = signal<string | null>(null);
  readonly assignmentError = signal<string | null>(null);
  readonly trackedPartner = signal<Partner | null>(null);
  readonly trackingDetails = signal<PlatformRegistrationDetails | null>(null);
  readonly trackingLoading = signal(false);
  readonly trackingError = signal<string | null>(null);
  readonly trackingRefreshedAt = signal<string | null>(null);
  readonly clockNow = signal(Date.now());
  private trackingRequestVersion = 0;
  private profileTrigger: HTMLElement | null = null;
  private jobDetailTrigger: HTMLElement | null = null;

  readonly activeJobs = computed(() => this.ops.liveJobs().map((job) => this.withCurrentSla(job)));

  readonly escalatedUnassignedJobs = computed(() =>
    this.activeJobs().filter((job) =>
      this.isUnassigned(job) && (this.unassignedMinutes(job) ?? 0) >= 15,
    ),
  );

  readonly repairStageBreakdown = computed(() => {
    const repairs = this.ops.activeRepairs();
    return (['received', 'diagnosis', 'repairing', 'qc'] as const)
      .map((stage) => ({
        stage,
        label: stage === 'qc' ? 'Quality check' : stage === 'diagnosis' ? 'Diagnosis' : stage,
        count: repairs.filter((repair) => repair.stage === stage).length,
      }))
      .filter((entry) => entry.count > 0 && !(entry.stage === 'received' && entry.count === repairs.length));
  });
  readonly repairSlaBreaches = computed(() => {
    const now = this.clockNow();
    return this.ops.activeRepairs().filter((repair) => {
      const receivedAt = new Date(repair.inAt).getTime();
      return Number.isFinite(receivedAt) && now - receivedAt > 7 * 86_400_000;
    });
  });

  readonly queueChartDatasets = computed(() => [{
    label: 'Jobs',
    data: [
      this.jobCount('unassigned'),
      this.jobCount('progress'),
      this.jobCount('at-risk'),
      this.jobCount('breached'),
    ],
    backgroundColor: ['#ffbd4a', '#42e8d5', '#ff8b57', '#ff5b7e'],
    borderRadius: 7,
    borderSkipped: false,
  }]);

  readonly filteredJobs = computed(() => {
    let jobs = this.activeJobs();
    switch (this.jobFilter()) {
      case 'unassigned':
        jobs = jobs.filter((job) => this.isUnassigned(job));
        break;
      case 'progress':
        jobs = jobs.filter((job) => job.status === 'progress');
        break;
      case 'at-risk':
        jobs = jobs.filter((job) =>
          job.slaMinsLeft !== null && job.slaMinsLeft > 0 && job.slaMinsLeft <= 60,
        );
        break;
      case 'breached':
        jobs = jobs.filter((job) => job.status === 'sla-risk');
        break;
    }
    const search = this.searchTerm().trim().toLocaleLowerCase();
    const type = this.jobTypeFilter();
    const highPriority = this.highPriorityOnly();
    return jobs.filter((job) => {
      const searchable = [
        job.id, job.company, job.site, job.siteAddress, job.service, job.category,
        job.partner, job.requester, job.contactPhone, job.asset, job.issue,
      ].filter(Boolean).join(' ').toLocaleLowerCase();
      const jobType = this.normalizedJobType(job);
      return (!search || searchable.includes(search)) &&
        (type === 'all' || type === jobType) &&
        (!highPriority || job.priority === 'high' || job.priority === 'critical');
    });
  });

  readonly jobs = computed(() => {
    const pageCount = Math.max(1, Math.ceil(this.filteredJobs().length / 20));
    const page = Math.min(this.jobPage(), pageCount);
    return this.filteredJobs().slice((page - 1) * 20, page * 20);
  });

  readonly jobPageCount = computed(() => Math.max(1, Math.ceil(this.filteredJobs().length / 20)));
  readonly currentJobPage = computed(() => Math.min(this.jobPage(), this.jobPageCount()));
  readonly selectedJob = computed(() =>
    this.ops.jobs()
      .filter((job) => job.id === this.selectedJobId())
      .map((job) => this.withCurrentSla(job))[0] ?? null,
  );

  readonly priorityJobs = computed(() =>
    [...this.activeJobs().filter((job) =>
      this.isUnassigned(job) &&
      (job.status === 'sla-risk' || (this.unassignedMinutes(job) ?? 0) >= 15),
    )]
      .sort((left, right) =>
        (left.slaMinsLeft ?? Number.MAX_SAFE_INTEGER) - (right.slaMinsLeft ?? Number.MAX_SAFE_INTEGER) ||
        this.priorityValue(right) - this.priorityValue(left) ||
        (this.unassignedMinutes(right) ?? 0) - (this.unassignedMinutes(left) ?? 0),
      )
      .slice(0, 4),
  );

  readonly openJobValue = computed(() =>
    this.activeJobs().reduce((total, job) => total + job.amount, 0),
  );

  readonly pricedJobCount = computed(() => this.activeJobs().filter((job) => job.amount > 0).length);
  readonly unpricedJobCount = computed(() => this.activeJobs().filter((job) => job.amount <= 0).length);

  readonly lowStockItems = computed(() =>
    this.auth.canAccess('inventory') ? this.ops.lowStockItems() : [],
  );

  readonly pendingSettlementTotal = computed(() =>
    this.auth.canAccess('finance') ? this.ops.pendingPayoutTotal() : null,
  );

  readonly todayServiceEarnings = computed(() =>
    this.auth.canAccess('analytics') ? this.ops.todayServiceEarnings() : null,
  );

  readonly recentPartnerActivity = computed(() =>
    [...(this.trackingDetails()?.activity ?? [])]
      .filter((activity) => activity.kind === 'job')
      .sort((left, right) =>
        (Date.parse(right.createdAt ?? '') || 0) - (Date.parse(left.createdAt ?? '') || 0),
      )
      .slice(0, 5),
  );

  readonly currentJobTimeline = computed(() => {
    const details = this.trackingDetails();
    const currentWork = details?.account.currentWork;
    if (!details || !currentWork) return [];
    const activity = details.activity.find((entry) =>
      entry.kind === 'job' &&
      (entry.id === currentWork.id || entry.reference === currentWork.reference),
    );
    return [...(activity?.timeline ?? [])].reverse().slice(0, 5);
  });

  constructor() {
    interval(30_000).pipe(takeUntilDestroyed()).subscribe(() => {
      this.clockNow.set(Date.now());
      const partner = this.trackedPartner();
      if (partner && !this.trackingLoading()) void this.loadTrackingProfile(partner, false);
    });
    interval(60_000).pipe(takeUntilDestroyed()).subscribe(() => {
      if (this.autoRefresh() && !this.isRefreshingJobs()) void this.refreshLiveJobs();
    });
  }

  setJobFilter(filter: LiveJobFilter): void {
    this.jobFilter.set(filter);
    this.jobPage.set(1);
  }

  setSearch(event: Event): void {
    this.searchTerm.set((event.target as HTMLInputElement).value);
    this.jobPage.set(1);
  }

  setJobType(event: Event): void {
    this.jobTypeFilter.set((event.target as HTMLSelectElement).value as JobTypeFilter);
    this.jobPage.set(1);
  }

  setHighPriority(event: Event): void {
    this.highPriorityOnly.set((event.target as HTMLInputElement).checked);
    this.jobPage.set(1);
  }

  previousJobPage(): void {
    this.jobPage.set(Math.max(1, this.currentJobPage() - 1));
  }

  nextJobPage(): void {
    this.jobPage.set(Math.min(this.jobPageCount(), this.currentJobPage() + 1));
  }

  async refreshLiveJobs(): Promise<void> {
    if (this.isRefreshingJobs()) return;
    this.isRefreshingJobs.set(true);
    try {
      await Promise.all([
        this.ops.refreshOperations(),
        ...(this.auth.canAccess('repair') ? [this.ops.refreshOperations('repair')] : []),
      ]);
    } finally {
      this.isRefreshingJobs.set(false);
    }
  }

  toggleAutoRefresh(): void {
    this.autoRefresh.update((enabled) => !enabled);
  }

  isUnassigned(job: Job): boolean {
    return !job.partnerId && !job.partner;
  }

  isSelected(jobId: string): boolean {
    return this.selectedJobIds().includes(jobId);
  }

  toggleJobSelection(jobId: string, event: Event): void {
    if (!this.auth.canAccess('jobs', 'edit')) return;
    const checked = (event.target as HTMLInputElement).checked;
    this.selectedJobIds.update((ids) => checked
      ? ids.includes(jobId) ? ids : [...ids, jobId]
      : ids.filter((id) => id !== jobId));
  }

  togglePageSelection(event: Event): void {
    if (!this.auth.canAccess('jobs', 'edit')) return;
    const checked = (event.target as HTMLInputElement).checked;
    const pageIds = this.jobs().filter((job) => this.isUnassigned(job)).map((job) => job.id);
    this.selectedJobIds.update((ids) => checked
      ? [...new Set([...ids, ...pageIds])]
      : ids.filter((id) => !pageIds.includes(id)));
  }

  allVisibleUnassignedSelected(): boolean {
    const selectable = this.jobs().filter((job) => this.isUnassigned(job));
    return selectable.length > 0 && selectable.every((job) => this.isSelected(job.id));
  }

  visibleRangeEnd(): number {
    return Math.min(this.currentJobPage() * 20, this.filteredJobs().length);
  }

  jobHistory(job: Job): JobActivity[] {
    return [...(job.activity ?? [])].reverse();
  }

  async autoAssignSelected(): Promise<void> {
    const selected = this.selectedJobIds();
    if (!selected.length || !this.auth.canAccess('jobs', 'edit')) return;
    this.assignmentMessage.set(null);
    this.assignmentError.set(null);
    let assigned = 0;
    const failures: string[] = [];
    for (const id of selected) {
      const job = this.ops.liveJobs().find((item) => item.id === id);
      if (!job || !this.isUnassigned(job)) {
        failures.push(`${id}: no longer available`);
        continue;
      }
      const partner = this.bestPartnerForJob(job);
      if (!partner) {
        failures.push(`${id}: no role-matched partner available`);
        continue;
      }
      try {
        await this.saveAssignment(job, partner.id);
        if (this.assignmentError()) {
          failures.push(`${id}: ${this.assignmentError()}`);
          continue;
        }
        assigned++;
      } catch (error) {
        failures.push(`${id}: ${this.api.errorMessage(error, 'assignment failed')}`);
      }
    }
    this.selectedJobIds.set([]);
    if (failures.length) {
      const details = failures.slice(0, 3).join('; ');
      this.assignmentError.set(`${assigned} assigned; ${failures.length} failed. ${details}${failures.length > 3 ? '; more failures omitted.' : ''}`);
    } else {
      this.assignmentMessage.set(`${assigned} selected job${assigned === 1 ? '' : 's'} assigned successfully.`);
    }
  }

  openJobDetails(jobId: string, event?: Event): void {
    this.jobDetailTrigger = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.selectedJobId.set(jobId);
  }

  closeJobDetails(): void {
    const trigger = this.jobDetailTrigger;
    this.jobDetailTrigger = null;
    this.selectedJobId.set(null);
    queueMicrotask(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }

  jobCount(filter: LiveJobFilter): number {
    switch (filter) {
      case 'unassigned': return this.activeJobs().filter((job) => this.isUnassigned(job)).length;
      case 'progress': return this.activeJobs().filter((job) => job.status === 'progress').length;
      case 'at-risk': return this.activeJobs().filter((job) =>
        job.slaMinsLeft !== null && job.slaMinsLeft > 0 && job.slaMinsLeft <= 60,
      ).length;
      case 'breached': return this.activeJobs().filter((job) => job.status === 'sla-risk').length;
      default: return this.activeJobs().length;
    }
  }

  unassignedMinutes(job: Job): number | null {
    if (!this.isUnassigned(job) || !job.createdAt) return null;
    const createdAt = Date.parse(job.createdAt);
    if (!Number.isFinite(createdAt) || createdAt > this.clockNow()) return null;
    return Math.floor((this.clockNow() - createdAt) / 60_000);
  }

  isDispatchEscalated(job: Job): boolean {
    return this.isUnassigned(job) &&
      ((this.unassignedMinutes(job) ?? 0) >= 15 || job.status === 'sla-risk');
  }

  unassignedAgeLabel(job: Job): string {
    const minutes = this.unassignedMinutes(job);
    if (minutes === null) return 'Unassigned age unavailable';
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours}h ${minutes % 60}m unassigned` : `${minutes}m unassigned`;
  }

  locationLabel(job: Job): string {
    if (this.currentLocation(job)) return 'GPS live';
    const lastUpdate = job.lastLocationAt || job.liveLocation?.updatedAt;
    if (lastUpdate) return `GPS stale · ${this.elapsedSince(lastUpdate)} ago`;
    return 'GPS unavailable';
  }

  currentLocation(job: Job): Job['liveLocation'] {
    const location = job.liveLocation;
    if (!location?.updatedAt) return null;
    const updatedAt = Date.parse(location.updatedAt);
    const age = this.clockNow() - updatedAt;
    return Number.isFinite(updatedAt) && age >= 0 && age <= 90 * 60_000
      ? location
      : null;
  }

  partnerGpsLabel(partner: Partner): string {
    if (!partner.lastLocationAt) return 'No GPS update for active job';
    const updatedAt = Date.parse(partner.lastLocationAt);
    const age = this.clockNow() - updatedAt;
    if (!Number.isFinite(updatedAt) || age < 0) return 'GPS timestamp unavailable';
    return age <= 90 * 60_000
      ? `GPS live · ${this.elapsedSince(partner.lastLocationAt)} ago`
      : `GPS stale · ${this.elapsedSince(partner.lastLocationAt)} ago`;
  }

  private withCurrentSla(job: Job): Job {
    if (!job.slaDueAt || job.status === 'completed') return job;
    const dueAt = Date.parse(job.slaDueAt);
    if (!Number.isFinite(dueAt)) return job;
    const slaMinsLeft = Math.ceil((dueAt - this.clockNow()) / 60_000);
    return {
      ...job,
      slaMinsLeft,
      status: slaMinsLeft <= 0 ? 'sla-risk' : this.isUnassigned(job) ? 'unassigned' : 'progress',
    };
  }

  jobStatusLabel(job: Job): string {
    if (job.status === 'sla-risk') return 'SLA overdue';
    return job.status === 'unassigned' ? 'Unassigned' : 'In progress';
  }

  formatSla(minutes: number | null): string {
    if (minutes === null) return 'SLA not set';
    if (minutes === 0) return 'Breached <1m';

    const absolute = Math.abs(minutes);
    const days = Math.floor(absolute / 1440);
    const hours = Math.floor((absolute % 1440) / 60);
    const remainingMinutes = absolute % 60;
    const duration = days
      ? `${days}d ${hours}h`
      : hours ? `${hours}h ${remainingMinutes}m` : `${remainingMinutes}m`;
    return minutes < 0 ? `${duration} overdue` : `${duration} left`;
  }

  formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(value);
  }

  formatExperience(value: string | null | undefined): string {
    if (!value) return 'Experience not recorded';
    return /\b(?:years?|yrs?)\b/i.test(value) ? value : `${value} years`;
  }

  matchingPartners(job: Job): Partner[] {
    const role = this.partnerTypeForJob(job);
    return this.ops.partnersOnline()
      .filter((partner) => !partner.busy && partner.verified && (!role || partner.type === role))
      .sort((left, right) =>
        jobSkillMatchCount(job, right) - jobSkillMatchCount(job, left) ||
        Number(right.verified) - Number(left.verified) ||
        right.rating - left.rating ||
        this.experienceValue(right.experienceYears) - this.experienceValue(left.experienceYears) ||
        right.jobsDone - left.jobsDone,
      );
  }

  partnerSkillMatchCount(job: Job, partner: Partner): number {
    return jobSkillMatchCount(job, partner);
  }

  bestPartnerForJob(job: Job): Partner | null {
    return this.matchingPartners(job)[0] ?? null;
  }

  partnerMatchLabel(partner: Partner): string {
    const matchingJobs = this.ops.liveJobs().filter((job) =>
      this.isUnassigned(job) && this.partnerTypeForJob(job) === partner.type,
    );
    if (!matchingJobs.length) return 'No matching open job';
    return `Best match · ${matchingJobs[0].id}`;
  }

  lowStockForJob(job: Job): InventoryItem[] {
    if (!this.auth.canAccess('inventory')) return [];
    const searchable = [job.asset, job.issue, job.service, job.category]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase();
    if (!searchable) return [];

    return this.lowStockItems().filter((item) =>
      [item.name, item.sku]
        .some((value) => value.length >= 3 && searchable.includes(value.toLocaleLowerCase())),
    );
  }

  async assign(job: Job, event: Event): Promise<void> {
    const target = event.target;
    if (target instanceof HTMLSelectElement) {
      await this.saveAssignment(job, target.value || null);
    }
  }

  async assignBestPartner(job: Job): Promise<void> {
    const partner = this.bestPartnerForJob(job);
    if (partner) await this.saveAssignment(job, partner.id);
  }

  jobMapUrl(job: Job): string | null {
    if (job.latitude !== null && job.latitude !== undefined &&
        job.longitude !== null && job.longitude !== undefined) {
      return this.mapUrl({ latitude: job.latitude, longitude: job.longitude });
    }
    const address = job.siteAddress || job.site;
    return address && address !== '—'
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
      : null;
  }

  estimateLabel(job: Job): string {
    return job.amountSource ? `Based on ${job.amountSource}` : 'No estimate recorded';
  }

  openPartnerProfile(partner: Partner, event?: Event): void {
    if (!this.auth.canAccess('directory')) return;
    this.profileTrigger = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.trackedPartner.set(partner);
    this.trackingDetails.set(null);
    this.trackingError.set(null);
    this.trackingRefreshedAt.set(null);
    void this.loadTrackingProfile(partner, true);
  }

  refreshPartnerProfile(): void {
    const partner = this.trackedPartner();
    if (partner && !this.trackingLoading()) void this.loadTrackingProfile(partner, false);
  }

  closePartnerProfile(): void {
    const trigger = this.profileTrigger;
    this.profileTrigger = null;
    this.trackingRequestVersion++;
    this.trackedPartner.set(null);
    this.trackingDetails.set(null);
    this.trackingError.set(null);
    this.trackingLoading.set(false);
    queueMicrotask(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }

  formatDate(value: string | null | undefined): string {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not recorded';
    return new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  }

  elapsedSince(value: string | null | undefined): string {
    if (!value) return 'Not recorded';
    const elapsedMs = this.clockNow() - Date.parse(value);
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 'Not available';
    const totalMinutes = Math.floor(elapsedMs / 60_000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    if (totalMinutes) return `${totalMinutes}m`;
    return 'Under a minute';
  }

  mapUrl(location: { latitude: number; longitude: number }): string {
    return `https://www.google.com/maps?q=${location.latitude},${location.longitude}`;
  }

  displayList(values: string[]): string {
    return values.length ? values.join(', ') : 'Not recorded';
  }

  private async loadTrackingProfile(partner: Partner, auditAccess: boolean): Promise<void> {
    const requestVersion = ++this.trackingRequestVersion;
    this.clockNow.set(Date.now());
    this.trackingLoading.set(true);
    if (auditAccess) this.trackingError.set(null);

    try {
      const id = `energy-hub:${partner.id}`;
      const details = auditAccess
        ? await this.api.openTrackingProfile(id)
        : await this.api.getRegistrationDetails(id);
      if (requestVersion !== this.trackingRequestVersion ||
          this.trackedPartner()?.id !== partner.id) return;
      this.trackingDetails.set(details);
      this.trackingRefreshedAt.set(new Date().toISOString());
      this.trackingError.set(null);
    } catch (error) {
      if (requestVersion === this.trackingRequestVersion) {
        this.trackingError.set(this.api.errorMessage(error, 'Partner tracking details could not be loaded.'));
        if (error instanceof HttpErrorResponse &&
            [401, 403, 404].includes(error.status)) {
          this.trackingDetails.set(null);
        }
      }
    } finally {
      if (requestVersion === this.trackingRequestVersion) this.trackingLoading.set(false);
    }
  }

  private partnerTypeForJob(job: Job): Partner['type'] | null {
    const targetRole = job.targetRole?.toLocaleLowerCase() ?? '';
    if (targetRole.includes('supplier') || targetRole.includes('delivery')) return 'supplier';
    if (targetRole.includes('repair')) return 'repairing';
    if (targetRole.includes('panel')) return 'panelmaker';
    if (targetRole.includes('service')) return 'service';
    const tokens = `${job.id} ${job.category ?? ''} ${job.service}`
      .toLocaleLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    if (tokens.some((token) => token === 'del' || token.startsWith('delivery'))) return 'supplier';
    if (tokens.some((token) => token === 'rep' || token.startsWith('repair'))) return 'repairing';
    if (tokens.some((token) => token === 'panel' || token.startsWith('panelmaker'))) return 'panelmaker';
    if (tokens.some((token) => token === 'svc' || token.startsWith('service'))) return 'service';
    return null;
  }

  private normalizedJobType(job: Job): JobTypeFilter | null {
    const value = (job.jobType || '').toLocaleLowerCase();
    if (value.includes('service')) return 'service';
    if (value.includes('repair')) return 'repair';
    if (value.includes('panel')) return 'panel';
    if (value.includes('delivery')) return 'delivery';
    return null;
  }

  private async saveAssignment(job: Job, partnerId: string | null): Promise<void> {
    if (!this.auth.canAccess('jobs', 'edit')) {
      this.assignmentError.set('You do not have permission to change job assignments.');
      return;
    }
    this.assignmentError.set(null);
    this.assignmentMessage.set(null);
    this.assignmentPending.update((pending) => ({ ...pending, [job.id]: true }));
    try {
      const result = await this.ops.assignJob(job.id, partnerId);
      this.assignmentMessage.set(result.refreshed
        ? partnerId ? `${job.id} assigned and queue refreshed.` : `${job.id} returned to the dispatch queue.`
        : 'Assignment saved, but the live queue did not refresh. Use Refresh to sync it.');
    } catch (error) {
      this.assignmentError.set(this.api.errorMessage(error, 'The job assignment could not be saved.'));
    } finally {
      this.assignmentPending.update((pending) => {
        const next = { ...pending };
        delete next[job.id];
        return next;
      });
    }
  }

  private experienceValue(value: string | null | undefined): number {
    const match = value?.match(/\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : 0;
  }

  private priorityValue(job: Job): number {
    if (job.priority === 'critical') return 3;
    if (job.priority === 'high') return 2;
    return job.priority === 'normal' ? 1 : 0;
  }
}
