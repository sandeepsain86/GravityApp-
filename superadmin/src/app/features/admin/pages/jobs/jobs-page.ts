import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval } from 'rxjs';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import {
  OperationsService,
  jobSkillMatchCount,
  type Job,
  type JobActivity,
  type Partner,
} from '../../../../core/services/operations.service';
import { AdminChart } from '../../../../shared/admin-chart/admin-chart';

type JobFilter = 'all' | 'unassigned' | 'sla-risk' | 'progress' | 'completed';
type JobSort = 'urgency' | 'sla' | 'amount' | 'newest';

@Component({
  selector: 'app-jobs-page',
  imports: [AdminChart],
  templateUrl: './jobs-page.html',
  styleUrl: './jobs-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JobsPage {
  readonly ops = inject(OperationsService);
  readonly auth = inject(AuthService);
  private readonly api = inject(AdminApiService);
  readonly activeFilter = signal<JobFilter>('all');
  readonly searchTerm = signal('');
  readonly sortBy = signal<JobSort>('urgency');
  readonly selectedJobId = signal<string | null>(null);
  readonly clockNow = signal(Date.now());
  readonly assignmentNotice = signal<string | null>(null);
  readonly assignmentError = signal<string | null>(null);

  readonly filters: { value: JobFilter; label: string }[] = [
    { value: 'all', label: 'All jobs' },
    { value: 'unassigned', label: 'Unassigned' },
    { value: 'sla-risk', label: 'SLA risk' },
    { value: 'progress', label: 'In progress' },
    { value: 'completed', label: 'Completed' },
  ];

  readonly metrics = computed(() => {
    const active = this.ops.liveJobs();
    const allJobs = this.ops.jobs();
    const share = (part: number, total: number) => total ? Math.round((part / total) * 100) : 0;
    const needsAttention = active.filter((job) => this.isSlaRisk(job)).length;
    const unassigned = this.ops.unassignedJobs().length;
    const priced = active.filter((job) => job.amount > 0).length;
    return [
      { label: 'Open jobs', value: String(active.length), detail: 'Awaiting or in delivery', tone: 'blue', icon: 'list', progress: share(active.length, allJobs.length), visualLabel: 'Open jobs as a share of all recorded jobs' },
      { label: 'Needs attention', value: String(needsAttention), detail: 'At or near SLA breach', tone: 'red', icon: 'warn', progress: share(needsAttention, active.length), visualLabel: 'Jobs at or near SLA breach as a share of the open queue' },
      { label: 'Unassigned', value: String(unassigned), detail: 'No service partner yet', tone: 'amber', icon: 'users', progress: share(unassigned, active.length), visualLabel: 'Unassigned jobs as a share of the open queue' },
      { label: 'Open value', value: this.formatCurrency(active.reduce((sum, job) => sum + job.amount, 0)), detail: 'Estimated work in queue', tone: 'green', icon: 'rupee', progress: share(priced, active.length), visualLabel: 'Open jobs with a stored estimate' },
    ];
  });

  readonly queueChartDatasets = computed(() => {
    const jobs = this.ops.jobs();
    const statuses: Job['status'][] = ['unassigned', 'progress', 'sla-risk', 'completed'];
    return [{
      label: 'Jobs',
      data: statuses.map((status) => jobs.filter((job) => job.status === status).length),
      backgroundColor: ['#ffbd4a', '#42e8d5', '#ff5b7e', '#8b7bff'],
      borderRadius: 7,
      borderSkipped: false,
    }];
  });

  constructor() {
    interval(60_000).pipe(takeUntilDestroyed()).subscribe(() => this.clockNow.set(Date.now()));
  }

  readonly filteredJobs = computed(() => {
    const search = this.searchTerm().trim().toLocaleLowerCase();
    const filter = this.activeFilter();
    const unassignedJobIds = new Set(this.ops.unassignedJobs().map((job) => job.id));
    const jobs = this.ops.jobs().filter((job) => {
      const matchesFilter = filter === 'all'
        || (filter === 'unassigned' && unassignedJobIds.has(job.id))
        || (filter === 'sla-risk' && this.isSlaRisk(job))
        || job.status === filter;
      const searchable = [
        job.id, job.company, job.site, job.siteAddress, job.service, job.category,
        job.partner, job.requester, job.asset, job.issue,
      ].filter(Boolean).join(' ').toLocaleLowerCase();
      return matchesFilter && (!search || searchable.includes(search));
    });

    return jobs.sort((left, right) => {
      switch (this.sortBy()) {
        case 'sla':
          return (left.slaMinsLeft ?? Number.MAX_SAFE_INTEGER) - (right.slaMinsLeft ?? Number.MAX_SAFE_INTEGER);
        case 'amount':
          return right.amount - left.amount;
        case 'newest':
          return (right.createdAt ?? '').localeCompare(left.createdAt ?? '');
        default:
          return this.urgencyRank(left) - this.urgencyRank(right)
            || (left.slaMinsLeft ?? Number.MAX_SAFE_INTEGER) - (right.slaMinsLeft ?? Number.MAX_SAFE_INTEGER);
      }
    });
  });

  readonly selectedJob = computed(
    () => this.ops.jobs().find((job) => job.id === this.selectedJobId()) ?? null,
  );

  setFilter(filter: JobFilter): void {
    this.activeFilter.set(filter);
  }

  setSearch(event: Event): void {
    this.searchTerm.set((event.target as HTMLInputElement).value);
  }

  setSort(event: Event): void {
    this.sortBy.set((event.target as HTMLSelectElement).value as JobSort);
  }

  count(filter: JobFilter): number {
    const jobs = this.ops.jobs();
    if (filter === 'all') return jobs.length;
    if (filter === 'unassigned') return this.ops.unassignedJobs().length;
    if (filter === 'sla-risk') return jobs.filter((job) => this.isSlaRisk(job)).length;
    return jobs.filter((job) => job.status === filter).length;
  }

  partnerOptions(job: Job): Partner[] {
    const role = this.partnerTypeForJob(job);
    return this.ops.partners().filter((partner) =>
      partner.online && !partner.busy && partner.verified && (!role || partner.type === role),
    ).sort((left, right) =>
      jobSkillMatchCount(job, right) - jobSkillMatchCount(job, left) ||
      right.rating - left.rating ||
      right.jobsDone - left.jobsDone,
    );
  }

  partnerSkillMatchCount(job: Job, partner: Partner): number {
    return jobSkillMatchCount(job, partner);
  }

  async assign(jobId: string, event: Event): Promise<void> {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    this.assignmentNotice.set(null);
    this.assignmentError.set(null);
    if (!this.auth.canAccess('jobs', 'edit')) {
      this.assignmentError.set('You do not have permission to change job assignments.');
      return;
    }
    try {
      const result = await this.ops.assignJob(jobId, target.value || null);
      this.assignmentNotice.set(result.refreshed
        ? 'Assignment saved to the database.'
        : 'Assignment saved, but the live job list could not be refreshed.');
    } catch (error) {
      this.assignmentError.set(this.api.errorMessage(error, 'The job assignment could not be saved.'));
    }
  }

  openDetails(jobId: string): void {
    this.selectedJobId.set(jobId);
  }

  openCardDetails(event: MouseEvent, jobId: string): void {
    const target = event.target;
    if (target instanceof Element && target.closest('button, input, select, textarea, a')) return;
    this.openDetails(jobId);
  }

  closeDetails(): void {
    this.selectedJobId.set(null);
  }

  activity(job: Job): JobActivity[] {
    return [...(job.activity ?? [])].reverse();
  }

  stageLabel(job: Job): string {
    const stage = job.rawStage || job.stage;
    if (!stage) return job.status === 'completed' ? 'Completed' : 'Stage not recorded';
    return stage.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  stageAge(job: Job): string {
    const latestStage = job.stageHistory?.at(-1);
    if (!latestStage?.at) return 'Stage history unavailable';
    const elapsed = this.clockNow() - Date.parse(latestStage.at);
    if (!Number.isFinite(elapsed) || elapsed < 0) return 'Stage timestamp unavailable';
    const minutes = Math.floor(elapsed / 60_000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  }

  recordedContribution(job: Job): number | null {
    if (job.totalBill === null || job.totalBill === undefined || job.totalBill <= 0 ||
        job.payoutAmount === null || job.payoutAmount === undefined ||
        job.partsTotal === null || job.partsTotal === undefined) return null;
    return job.totalBill - job.payoutAmount - job.partsTotal;
  }

  recordedContributionLabel(job: Job): string {
    const contribution = this.recordedContribution(job);
    return contribution === null ? 'Insufficient data' : this.formatCurrency(contribution);
  }

  statusLabel(job: Job): string {
    if (job.status === 'sla-risk') return 'SLA risk';
    if (job.status === 'progress') return 'In progress';
    if (job.status === 'completed') return 'Completed';
    return 'Unassigned';
  }

  priorityLabel(job: Job): string {
    const priority = job.priority ?? 'normal';
    return priority.charAt(0).toUpperCase() + priority.slice(1);
  }

  slaPercent(job: Job): number {
    if (job.slaMinsLeft === null) return 100;
    return Math.max(4, Math.min(100, Math.round((job.slaMinsLeft / 120) * 100)));
  }

  formatCurrency(amount: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(amount);
  }

  formatDate(value: string | null | undefined): string {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  }

  isSlaRisk(job: Job): boolean {
    return job.status !== 'completed'
      && (job.status === 'sla-risk' || (job.slaMinsLeft !== null && job.slaMinsLeft <= 10));
  }

  private partnerTypeForJob(job: Job): Partner['type'] | null {
    const role = job.targetRole?.toLocaleLowerCase() ?? '';
    if (role.includes('supplier') || role.includes('delivery')) return 'supplier';
    if (role.includes('repair')) return 'repairing';
    if (role.includes('panel')) return 'panelmaker';
    if (role.includes('service')) return 'service';
    return null;
  }

  private urgencyRank(job: Job): number {
    if (this.isSlaRisk(job)) return 0;
    if (job.status === 'unassigned' || !job.partner) return 1;
    if (job.status === 'completed') return 3;
    return 2;
  }
}
