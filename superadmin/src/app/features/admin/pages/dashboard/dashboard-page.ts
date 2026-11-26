import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AdminUser, PageKey, PlatformRegistration, Role } from '../../../../core/models/user.model';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { OperationsService, type Job } from '../../../../core/services/operations.service';

type CustomerFilter = 'all' | 'active' | 'follow-up';

interface DashboardMetric {
  label: string;
  value: string;
  context: string;
  route: string;
  page: PageKey;
  tone: 'primary' | 'accent' | 'warn' | 'danger';
}

interface AttentionItem {
  label: string;
  detail: string;
  value: string;
  count: number;
  route: string;
  page: PageKey;
  tone: 'warn' | 'danger' | 'primary';
}

interface DashboardInsight {
  title: string;
  detail: string;
  action: string;
  route: string;
  page: PageKey;
  tone: 'positive' | 'info' | 'warn' | 'danger';
}

@Component({
  selector: 'app-dashboard-page',
  imports: [RouterLink],
  templateUrl: './dashboard-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardPage {
  private readonly api = inject(AdminApiService);
  private readonly auth = inject(AuthService);
  readonly ops = inject(OperationsService);

  readonly registrations = signal<PlatformRegistration[]>([]);
  readonly consoleUsers = signal<AdminUser[]>([]);
  readonly loadingPlatformData = signal(true);
  readonly platformDataErrors = signal<string[]>([]);
  readonly revenueMonths = signal<3 | 6>(6);
  readonly customerFilter = signal<CustomerFilter>('all');

  constructor() {
    void this.loadPlatformData();
  }

  readonly metrics = computed(() => {
    const riskCount = this.ops.slaRiskJobs().length;
    const registrations = this.registrations();
    const ratings = registrations.filter((registration) => registration.profile.rating !== null);
    const averageRating = ratings.length
      ? ratings.reduce((sum, registration) => sum + (registration.profile.rating ?? 0), 0) / ratings.length
      : null;
    const energyHubAccounts = registrations.filter((registration) => registration.app === 'energy-hub').length;
    const serviceAdminAccounts = registrations.filter((registration) => registration.app === 'service-admin').length;
    const activeUsers = this.consoleUsers().filter((user) => !user.disabled).length;
    const candidates: DashboardMetric[] = [
      {
        label: 'Platform registrations',
        value: this.loadingPlatformData() ? '…' : `${registrations.length}`,
        context: `${energyHubAccounts} Energy Hub · ${serviceAdminAccounts} Service Admin`,
        route: '/directory',
        page: 'directory',
        tone: 'primary',
      },
      {
        label: 'Console users',
        value: this.loadingPlatformData() ? '…' : `${this.consoleUsers().length}`,
        context: `${activeUsers} active accounts`,
        route: '/modules/users',
        page: 'users',
        tone: 'accent',
      },
      {
        label: 'Provider rating',
        value: averageRating === null ? '—' : `${averageRating.toFixed(1)} / 5`,
        context: `${ratings.length} providers with a saved score`,
        route: '/directory',
        page: 'directory',
        tone: averageRating !== null && averageRating < 4 ? 'warn' : 'primary',
      },
      {
        label: 'SLA-risk jobs',
        value: `${riskCount}`,
        context: `${this.ops.liveJobs().length} open jobs in connected database records`,
        route: '/jobs',
        page: 'jobs',
        tone: riskCount ? 'danger' : 'accent',
      },
    ];
    return candidates.filter((metric) => this.auth.canAccess(metric.page));
  });

  readonly appBreakdown = computed(() => {
    const registrations = this.registrations();
    const apps: Array<{ app: PlatformRegistration['app']; label: string; color: string }> = [
      { app: 'energy-hub', label: 'Energy Hub', color: 'var(--theme-1)' },
      { app: 'service-admin', label: 'Service Admin', color: 'var(--theme-2)' },
    ];
    const items = apps.map((item) => ({
      ...item,
      count: registrations.filter((registration) => registration.app === item.app).length,
    }));
    const total = registrations.length;
    let offset = 0;
    const segments = items.map((item) => {
      const start = offset;
      offset += total ? item.count / total * 100 : 0;
      return `${item.color} ${start}% ${offset}%`;
    });

    return {
      total,
      items,
      donutStyle: {
        background: total
          ? `radial-gradient(var(--surface) 58%, transparent 60%), conic-gradient(${segments.join(', ')})`
          : 'var(--surface-2)',
      },
    };
  });

  readonly roleBreakdown = computed(() => {
    const users = this.consoleUsers();
    const roles: Array<{ role: Role; label: string; color: string }> = [
      { role: 'superadmin', label: 'Superadmin', color: 'var(--theme-accent-2)' },
      { role: 'admin', label: 'Admin', color: 'var(--theme-1)' },
      { role: 'viewer', label: 'Viewer', color: 'var(--theme-2)' },
    ];
    return roles.map((item) => ({
      ...item,
      count: users.filter((user) => user.role === item.role).length,
      percentage: users.length
        ? Math.round((users.filter((user) => user.role === item.role).length / users.length) * 100)
        : 0,
    }));
  });

  readonly providerPerformance = computed(() =>
    this.registrations()
      .filter((registration) => registration.app === 'energy-hub')
      .map((registration) => ({
        ...registration,
        displayName: registration.profile.businessName ||
          registration.profile.companyName ||
          registration.name,
        experienceValue: this.experienceValue(registration.profile.experienceYears),
        stars: Array.from(
          { length: 5 },
          (_, index) => index < Math.round(registration.profile.rating ?? 0),
        ),
      }))
      .sort((a, b) =>
        (b.profile.rating ?? 0) - (a.profile.rating ?? 0) ||
        b.experienceValue - a.experienceValue ||
        b.profile.completedServices - a.profile.completedServices,
      ),
  );

  readonly customerPerformance = computed(() => {
    const filter = this.customerFilter();
    const companies = this.ops.companies
      .filter((company) =>
        filter === 'all' ||
        (filter === 'active' ? company.amc === 'Active' : company.amc !== 'Active'),
      )
      .sort((a, b) => b.revenue - a.revenue);
    const maximumRevenue = Math.max(...companies.map((company) => company.revenue), 1);
    const totalRevenue = this.ops.companies.reduce((sum, company) => sum + company.revenue, 0);
    return companies.map((company) => ({
      ...company,
      revenuePercent: Math.round((company.revenue / maximumRevenue) * 100),
      portfolioShare: totalRevenue ? Math.round((company.revenue / totalRevenue) * 100) : 0,
    }));
  });

  readonly customerSummary = computed(() => ({
    companies: this.ops.companies.length,
    users: this.ops.companies.reduce((sum, company) => sum + company.users, 0),
    sites: this.ops.companies.reduce((sum, company) => sum + company.sites, 0),
    followUp: this.ops.companies.filter((company) => company.amc !== 'Active').length,
  }));

  readonly smartInsights = computed(() => {
    const candidates: DashboardInsight[] = [];
    const riskJobs = this.ops.slaRiskJobs();
    const unassignedJobs = this.ops.jobs().filter((job) => job.status === 'unassigned');
    const expiringAmcs = this.ops.expiringAmcs();
    const overdueInvoices = this.ops.invoices().filter((invoice) => invoice.status === 'overdue');
    const largestCustomer = [...this.ops.companies].sort((a, b) => b.revenue - a.revenue)[0];
    const customerRevenue = this.ops.companies.reduce((sum, company) => sum + company.revenue, 0);
    const lowestRatedProvider = this.registrations()
      .filter((registration) => registration.profile.rating !== null)
      .sort((a, b) => (a.profile.rating ?? 0) - (b.profile.rating ?? 0))[0];

    if (riskJobs.length && this.auth.canAccess('jobs')) {
      candidates.push({
        title: `${riskJobs.length} job${riskJobs.length === 1 ? '' : 's'} at SLA risk`,
        detail: 'Assign an available provider and review the due-time plan before the SLA window closes.',
        action: 'Review jobs',
        route: '/jobs',
        page: 'jobs',
        tone: 'danger',
      });
    }
    if (unassignedJobs.length && this.auth.canAccess('jobs')) {
      candidates.push({
        title: `${unassignedJobs.length} unassigned job${unassignedJobs.length === 1 ? '' : 's'}`,
        detail: 'Matching these requests with an online provider can reduce time-to-start.',
        action: 'Open job queue',
        route: '/jobs',
        page: 'jobs',
        tone: 'warn',
      });
    }
    if (expiringAmcs.length && this.auth.canAccess('amc')) {
      candidates.push({
        title: `${expiringAmcs.length} contract${expiringAmcs.length === 1 ? '' : 's'} expiring soon`,
        detail: 'Contact the listed customer accounts and confirm renewal or service coverage.',
        action: 'Review contracts',
        route: '/amc',
        page: 'amc',
        tone: 'warn',
      });
    }
    if (overdueInvoices.length && this.auth.canAccess('invoices')) {
      candidates.push({
        title: `${overdueInvoices.length} overdue invoice${overdueInvoices.length === 1 ? '' : 's'}`,
        detail: `${this.formatCurrency(overdueInvoices.reduce((sum, invoice) => sum + invoice.amount, 0))} is marked overdue in the connected invoice source.`,
        action: 'Review invoices',
        route: '/invoices',
        page: 'invoices',
        tone: 'danger',
      });
    }
    if (
      largestCustomer &&
      customerRevenue > 0 &&
      largestCustomer.revenue / customerRevenue >= 0.4 &&
      this.auth.canAccess('companies')
    ) {
      candidates.push({
        title: `${largestCustomer.name} represents ${Math.round((largestCustomer.revenue / customerRevenue) * 100)}% of recorded customer value`,
        detail: 'Protect this account while building new opportunities across the rest of the customer portfolio.',
        action: 'Review customers',
        route: '/companies',
        page: 'companies',
        tone: 'info',
      });
    }
    if (
      lowestRatedProvider &&
      (lowestRatedProvider.profile.rating ?? 5) < 4.5 &&
      this.auth.canAccess('directory')
    ) {
      candidates.push({
        title: `${lowestRatedProvider.profile.businessName || lowestRatedProvider.profile.companyName || lowestRatedProvider.name} has a ${lowestRatedProvider.profile.rating}/5 rating`,
        detail: 'Review the saved profile score alongside experience and completed service outcomes.',
        action: 'Review provider',
        route: '/directory',
        page: 'directory',
        tone: 'info',
      });
    }

    if (!candidates.length && this.auth.canAccess('directory')) {
      const topProvider = this.providerPerformance()[0];
      if (topProvider && (topProvider.profile.rating ?? 0) >= 4.5) {
        candidates.push({
          title: `${topProvider.displayName} leads provider ratings`,
          detail: `${topProvider.profile.rating}/5 saved profile score, with ${topProvider.profile.experienceYears || 'unrecorded'} years of experience and ${topProvider.profile.completedServices} completed services.`,
          action: 'View directory',
          route: '/directory',
          page: 'directory',
          tone: 'positive',
        });
      }
    }

    return candidates.slice(0, 5);
  });

  readonly aiOverview = computed(() => {
    const riskCount = this.ops.slaRiskJobs().length;
    const accountCount = this.registrations().length;
    if (this.loadingPlatformData()) return 'Loading live platform registrations and console users.';
    if (this.platformDataErrors().length) return 'Some live account data could not be loaded; review the error message above before acting on these insights.';
    if (!this.auth.canAccess('directory')) return 'Review operational activity, customer portfolio, and service performance below.';
    if (riskCount) {
      return `${accountCount} live platform registrations. ${riskCount} connected job${riskCount === 1 ? ' is' : 's are'} flagged for SLA follow-up; prioritize assignment and protect customer coverage.`;
    }
    return `${accountCount} live platform registrations. No SLA-risk jobs are currently flagged in connected records; review provider ratings and customer portfolio trends below.`;
  });

  readonly priorityJobs = computed(() => {
    if (!this.auth.canAccess('jobs')) return [];
    const order: Record<Job['status'], number> = {
      'sla-risk': 0,
      unassigned: 1,
      progress: 2,
      completed: 3,
    };
    return [...this.ops.liveJobs()]
      .sort((a, b) => order[a.status] - order[b.status] ||
        (a.slaMinsLeft ?? Number.MAX_SAFE_INTEGER) - (b.slaMinsLeft ?? Number.MAX_SAFE_INTEGER))
      .slice(0, 4);
  });

  readonly attentionItems = computed(() => {
    const overdue = this.ops.invoices().filter((invoice) => invoice.status === 'overdue');
    const payouts = this.ops.pendingPayouts();
    const candidates: AttentionItem[] = [
      {
        label: 'Partner applications',
        detail: 'Documents awaiting review',
        value: `${this.ops.pendingApprovals()}`,
        count: this.ops.pendingApprovals(),
        route: '/verification',
        page: 'verification',
        tone: 'warn',
      },
      {
        label: 'Open disputes',
        detail: 'Need an owner and resolution',
        value: `${this.ops.openDisputes().length}`,
        count: this.ops.openDisputes().length,
        route: '/disputes',
        page: 'disputes',
        tone: 'danger',
      },
      {
        label: 'Overdue invoices',
        detail: this.formatCurrency(overdue.reduce((sum, invoice) => sum + invoice.amount, 0)),
        value: `${overdue.length}`,
        count: overdue.length,
        route: '/invoices',
        page: 'invoices',
        tone: 'danger',
      },
      {
        label: 'Partner payouts pending',
        detail: `${payouts.length} settlements to review`,
        value: this.formatCurrency(this.ops.pendingPayoutTotal()),
        count: payouts.length,
        route: '/finance',
        page: 'finance',
        tone: 'primary',
      },
      {
        label: 'Low-stock items',
        detail: 'Below the configured minimum',
        value: `${this.ops.lowStockItems().length}`,
        count: this.ops.lowStockItems().length,
        route: '/inventory',
        page: 'inventory',
        tone: 'warn',
      },
      {
        label: 'Contracts expiring soon',
        detail: 'Within the next 30 days',
        value: `${this.ops.expiringAmcs().length}`,
        count: this.ops.expiringAmcs().length,
        route: '/amc',
        page: 'amc',
        tone: 'warn',
      },
    ];
    return candidates.filter((item) => item.count > 0 && this.auth.canAccess(item.page)).slice(0, 5);
  });

  readonly revenueTrend = computed(() => {
    const points = this.ops.revenueTrend.slice(-this.revenueMonths());
    const maximum = Math.max(...points.map((point) => point.value), 1);
    return points.map((point) => ({
      ...point,
      height: Math.max(8, Math.round((point.value / maximum) * 100)),
    }));
  });

  readonly jobStatusBreakdown = computed(() => {
    const jobs = this.ops.jobs();
    const statuses: { status: Job['status']; label: string; color: string }[] = [
      { status: 'progress', label: 'In progress', color: 'var(--theme-1)' },
      { status: 'unassigned', label: 'Unassigned', color: 'var(--theme-accent-2)' },
      { status: 'sla-risk', label: 'SLA risk', color: 'var(--theme-accent-1)' },
      { status: 'completed', label: 'Completed', color: '#15803d' },
    ];

    return statuses.map(({ status, label, color }) => {
      const count = jobs.filter((job) => job.status === status).length;
      return {
        status,
        label,
        color,
        count,
        percentage: jobs.length ? Math.round((count / jobs.length) * 100) : 0,
      };
    });
  });

  readonly canViewJobs = computed(() => this.auth.canAccess('jobs'));
  readonly canViewFinance = computed(() => this.auth.canAccess('finance'));
  readonly canViewDirectory = computed(() => this.auth.canAccess('directory'));
  readonly canViewUsers = computed(() => this.auth.canAccess('users'));
  readonly canViewCompanies = computed(() => this.auth.canAccess('companies'));
  readonly canLoadPlatformData = computed(() => this.canViewDirectory() || this.canViewUsers());

  async loadPlatformData(): Promise<void> {
    this.loadingPlatformData.set(true);
    this.platformDataErrors.set([]);
    const requests: Promise<void>[] = [];

    if (this.auth.canAccess('directory')) {
      requests.push(this.loadRegistrations());
    }
    if (this.auth.canAccess('users')) {
      requests.push(this.loadConsoleUsers());
    }

    await Promise.all(requests);
    this.loadingPlatformData.set(false);
  }

  setRevenueMonths(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLSelectElement) {
      this.revenueMonths.set(target.value === '3' ? 3 : 6);
    }
  }

  formatRating(value: number | null): string {
    return value === null ? '—' : value.toFixed(1);
  }

  formatExperience(value: string | null): string {
    if (!value) return 'Experience not recorded';
    return /\b(?:years?|yrs?)\b/i.test(value) ? value : `${value} years`;
  }

  private experienceValue(value: string | null): number {
    const match = value?.match(/\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : 0;
  }

  private async loadRegistrations(): Promise<void> {
    try {
      this.registrations.set(await this.api.getRegistrations());
    } catch (error) {
      this.addPlatformDataError(this.api.errorMessage(error, 'Unable to load platform registrations.'));
    }
  }

  private async loadConsoleUsers(): Promise<void> {
    try {
      this.consoleUsers.set(await this.api.getUsers());
    } catch (error) {
      this.addPlatformDataError(this.api.errorMessage(error, 'Unable to load console users.'));
    }
  }

  private addPlatformDataError(message: string): void {
    this.platformDataErrors.update((errors) => [...errors, message]);
  }

  formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(value);
  }

  jobStatusLabel(job: Job): string {
    if (job.status === 'sla-risk') return 'SLA risk';
    return job.status === 'unassigned' ? 'Unassigned' : 'In progress';
  }

  jobTimeLabel(job: Job): string {
    if (job.slaMinsLeft === null) return 'SLA not set';
    return job.slaMinsLeft <= 0 ? 'Overdue' : `${job.slaMinsLeft} min left`;
  }
}
