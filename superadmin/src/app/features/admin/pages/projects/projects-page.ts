import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ChartDataset } from 'chart.js';
import { AdminApiService, type ProjectMilestoneInput } from '../../../../core/services/admin-api.service';
import {
  OperationsService,
  type ProjectMilestone,
  type ProjectRequest,
  type ProjectStatus,
} from '../../../../core/services/operations.service';
import { AuthService } from '../../../../core/services/auth.service';
import { AdminChart, type ChartSelection } from '../../../../shared/admin-chart/admin-chart';

type QueueFilter = 'all' | 'at-risk' | 'material-hold' | 'signoff' | 'high-value';
type QueueView = 'table' | 'board' | 'gantt';
type ChartFilter = { kind: 'status' | 'health' | 'lead' | 'project'; value: string } | null;

const CLOSED_STATUSES: ProjectStatus[] = ['completed', 'cancelled'];
const ADMIN_TRANSITIONS: Partial<Record<ProjectStatus, ProjectStatus[]>> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['under_review'],
  under_review: ['clarification_required', 'approved', 'cancelled'],
  clarification_required: ['under_review', 'cancelled'],
  approved: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
};

const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

@Component({
  selector: 'app-projects-page',
  imports: [AdminChart, FormsModule],
  templateUrl: './projects-page.html',
  styleUrl: './projects-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectsPage {
  readonly ops = inject(OperationsService);
  readonly auth = inject(AuthService);
  private readonly api = inject(AdminApiService);

  readonly queueFilter = signal<QueueFilter>('all');
  readonly queueView = signal<QueueView>('table');
  readonly chartFilter = signal<ChartFilter>(null);
  readonly searchText = signal('');
  readonly selectedProject = signal<ProjectRequest | null>(null);
  readonly saving = signal(false);
  readonly notice = signal('');
  readonly error = signal('');
  readonly milestoneForm: {
    title: string;
    plannedStart: string;
    dueDate: string;
    leadEngineerName: string;
    budgetAmount: number | null;
    materialCost: number | null;
    partnerPayout: number | null;
    billedAmount: number | null;
    clientSignoffStatus: 'not_required' | 'pending';
  } = {
    title: '',
    plannedStart: '',
    dueDate: '',
    leadEngineerName: '',
    budgetAmount: null,
    materialCost: null,
    partnerPayout: null,
    billedAmount: null,
    clientSignoffStatus: 'pending',
  };
  readonly financialMilestoneId = signal<string | null>(null);
  readonly financialForm = {
    materialCost: null as number | null,
    partnerPayout: null as number | null,
    billedAmount: null as number | null,
  };

  readonly projects = computed(() => this.ops.projects());

  readonly queueFilters = computed(() => {
    const projects = this.projects();
    return [
      { id: 'all' as const, label: 'All projects', count: projects.length },
      { id: 'at-risk' as const, label: 'Delayed / at risk', count: projects.filter((p) => this.isAtRisk(p)).length },
      { id: 'material-hold' as const, label: 'Material hold', count: projects.filter((p) => this.hasMaterialHold(p)).length },
      { id: 'signoff' as const, label: 'Pending sign-off', count: projects.filter((p) => this.needsSignoff(p)).length },
      { id: 'high-value' as const, label: 'High value', count: projects.filter((p) => this.isHighValue(p)).length },
    ];
  });

  readonly filteredProjects = computed(() => {
    const search = this.searchText().trim().toLocaleLowerCase();
    const filter = this.queueFilter();
    const chartFilter = this.chartFilter();
    return this.projects().filter((project) => {
      if (filter === 'at-risk' && !this.isAtRisk(project)) return false;
      if (filter === 'material-hold' && !this.hasMaterialHold(project)) return false;
      if (filter === 'signoff' && !this.needsSignoff(project)) return false;
      if (filter === 'high-value' && !this.isHighValue(project)) return false;
      if (search && ![project.id, project.company, project.title, project.site, project.category]
        .some((value) => value.toLocaleLowerCase().includes(search))) return false;
      if (!chartFilter) return true;
      if (chartFilter.kind === 'status') return project.status === chartFilter.value;
      if (chartFilter.kind === 'health') return this.healthLabel(project) === chartFilter.value;
      if (chartFilter.kind === 'project') return project.title === chartFilter.value || project.id === chartFilter.value;
      return project.milestones.some((milestone) => milestone.leadEngineerName === chartFilter.value);
    });
  });

  readonly executiveKpis = computed(() => {
    const projects = this.projects();
    const active = projects.filter((project) => !CLOSED_STATUSES.includes(project.status));
    const atRisk = active.filter((project) => this.isAtRisk(project)).length;
    const knownBudgets = active.filter((project) => project.currency === 'INR' && project.value !== null);
    const pipeline = active.reduce((sum, project) =>
      project.currency === 'INR' ? sum + (project.value ?? 0) : sum, 0);
    const budgetMilestones = active.flatMap((project) =>
      project.currency === 'INR' ? project.milestones : [])
      .filter((milestone) => milestone.budgetAmount !== null);
    const unbilled = budgetMilestones.reduce((sum, milestone) =>
      sum + Math.max(0, (milestone.budgetAmount ?? 0) - (milestone.billedAmount ?? 0)), 0);
    const completedMilestones = projects.flatMap((project) => project.milestones)
      .filter((milestone) => milestone.status === 'completed' && milestone.completedAt && milestone.dueDate);
    const onTime = completedMilestones.filter((milestone) =>
      milestone.completedAt!.slice(0, 10) <= milestone.dueDate).length;
    const financial = this.recordedFinancials(projects);
    const margin = financial.revenue > 0
      ? `${Math.round(((financial.revenue - financial.costs) / financial.revenue) * 100)}%`
      : 'Not recorded';
    const held = active.filter((project) =>
      this.hasMaterialHold(project) || project.milestones.some((milestone) => milestone.status === 'blocked')).length;
    return [
      {
        key: 'health',
        label: 'Active project health',
        value: `${active.length - atRisk} / ${active.length}`,
        detail: `${atRisk} delayed, blocked, or at risk`,
        tone: atRisk ? 'warning' : 'success',
        icon: 'pulse',
      },
      {
        key: 'pipeline',
        label: 'Budget pipeline',
        value: knownBudgets.length ? this.currencyLabel(pipeline) : 'Not recorded',
        detail: `${budgetMilestones.length ? this.currencyLabel(unbilled) : 'Not recorded'} known unbilled · INR budgets`,
        tone: 'info',
        icon: 'rupee',
      },
      {
        key: 'delivery',
        label: 'Milestones on time',
        value: completedMilestones.length ? `${Math.round((onTime / completedMilestones.length) * 100)}%` : 'Not recorded',
        detail: `${onTime} of ${completedMilestones.length} completed milestones`,
        tone: completedMilestones.length && onTime === completedMilestones.length ? 'success' : 'info',
        icon: 'check',
      },
      {
        key: 'margin',
        label: 'Gross margin',
        value: margin,
        detail: financial.matches
          ? `${this.currencyLabel(financial.revenue - financial.costs)} from recorded milestone billing and costs`
          : 'Enter billed value and costs on milestones',
        tone: financial.matches && financial.revenue > financial.costs ? 'success' : 'neutral',
        icon: 'chart',
      },
      {
        key: 'holds',
        label: 'Blocked / material hold',
        value: String(held),
        detail: `${projects.reduce((sum, project) => sum + project.milestones.filter((item) => item.clientSignoffStatus === 'pending').length, 0)} milestone sign-offs pending`,
        tone: held ? 'danger' : 'success',
        icon: 'warn',
      },
    ];
  });

  readonly lifecycleCounts = computed(() => {
    const stages: Array<{ status: ProjectStatus; label: string }> = [
      { status: 'draft', label: 'Draft' },
      { status: 'submitted', label: 'Submitted' },
      { status: 'under_review', label: 'Under review' },
      { status: 'clarification_required', label: 'Clarification' },
      { status: 'approved', label: 'Approved' },
      { status: 'in_progress', label: 'In progress' },
      { status: 'completed', label: 'Completed' },
      { status: 'cancelled', label: 'Cancelled' },
    ];
    return stages.map((stage) => ({
      ...stage,
      count: this.projects().filter((project) => project.status === stage.status).length,
    }));
  });

  readonly lifecycleDatasets = computed<ChartDataset<'bar', number[]>[]>(() => [{
    label: 'Projects',
    data: this.lifecycleCounts().map((stage) => stage.count),
    backgroundColor: this.lifecycleCounts().map((_stage, index) => COLORS[index % COLORS.length]),
    borderRadius: 5,
    maxBarThickness: 26,
  }]);

  readonly boardStages = computed(() => this.lifecycleCounts());

  readonly budgetProjects = computed(() => this.projects()
    .filter((project) => project.currency === 'INR' &&
      project.value !== null &&
      project.milestones.some((milestone) => milestone.materialCost !== null || milestone.partnerPayout !== null)));

  readonly budgetDatasets = computed<ChartDataset<'bar', number[]>[]>(() => [{
    label: 'Approved budget',
    data: this.budgetProjects().map((project) => project.value ?? 0),
    backgroundColor: 'rgba(99, 102, 241, .7)',
    borderRadius: 4,
  }, {
    label: 'Recorded costs',
    data: this.budgetProjects().map((project) => project.milestones.reduce((sum, milestone) =>
      sum + (milestone.materialCost ?? 0) + (milestone.partnerPayout ?? 0), 0)),
    backgroundColor: 'rgba(14, 165, 233, .75)',
    borderRadius: 4,
  }]);

  readonly burnup = computed(() => {
    const now = new Date();
    const months = Array.from({ length: 6 }, (_value, index) => {
      const month = new Date(now.getFullYear(), now.getMonth() - 5 + index, 1);
      return {
        key: `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`,
        label: month.toLocaleDateString('en-IN', { month: 'short' }),
      };
    });
    const milestones = this.projects().flatMap((project) => project.milestones);
    return {
      labels: months.map((month) => month.label),
      planned: months.map((month) =>
        milestones.filter((item) => item.dueDate && item.dueDate.slice(0, 7) <= month.key).length),
      completed: months.map((month) =>
        milestones.filter((item) => item.completedAt && item.completedAt.slice(0, 7) <= month.key).length),
      hasData: milestones.some((item) => item.dueDate || item.completedAt),
    };
  });

  readonly burnupDatasets = computed<ChartDataset<'line', number[]>[]>(() => [{
    label: 'Planned cumulative',
    data: this.burnup().planned,
    borderColor: '#6366f1',
    backgroundColor: 'rgba(99, 102, 241, .1)',
    fill: true,
    tension: .35,
  }, {
    label: 'Completed cumulative',
    data: this.burnup().completed,
    borderColor: '#10b981',
    backgroundColor: 'rgba(16, 185, 129, .1)',
    fill: true,
    tension: .35,
  }]);

  readonly healthCounts = computed(() => {
    const active = this.projects().filter((project) => !CLOSED_STATUSES.includes(project.status));
    return [
      { label: 'Healthy', value: active.filter((project) => this.healthLabel(project) === 'Healthy').length },
      { label: 'Watch', value: active.filter((project) => this.healthLabel(project) === 'Watch').length },
      { label: 'At risk', value: active.filter((project) => this.healthLabel(project) === 'At risk').length },
    ];
  });

  readonly healthDatasets = computed<ChartDataset<'doughnut', number[]>[]>(() => [{
    label: 'Active projects',
    data: this.healthCounts().map((entry) => entry.value),
    backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
    borderWidth: 0,
  }]);

  readonly leadCounts = computed(() => {
    const counts = new Map<string, number>();
    for (const project of this.projects().filter((item) => !CLOSED_STATUSES.includes(item.status))) {
      for (const milestone of project.milestones) {
        if (milestone.leadEngineerName) {
          counts.set(milestone.leadEngineerName, (counts.get(milestone.leadEngineerName) ?? 0) + 1);
        }
      }
    }
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([label, value]) => ({ label, value }));
  });

  readonly leadDatasets = computed<ChartDataset<'bar', number[]>[]>(() => [{
    label: 'Assigned milestones',
    data: this.leadCounts().map((entry) => entry.value),
    backgroundColor: 'rgba(139, 92, 246, .72)',
    borderRadius: 4,
  }]);

  readonly ganttWindow = computed(() => {
    const dates = this.projects().flatMap((project) => project.milestones.flatMap((milestone) =>
      [milestone.plannedStart, milestone.dueDate].filter((date): date is string => !!date)));
    if (!dates.length) return null;
    return {
      start: [...dates].sort()[0],
      end: [...dates].sort().at(-1)!,
    };
  });

  setQueueFilter(filter: QueueFilter): void {
    this.queueFilter.set(filter);
    this.chartFilter.set(null);
  }

  onChartSelect(kind: 'status' | 'health' | 'lead' | 'project', selection: ChartSelection): void {
    this.queueFilter.set('all');
    const value = kind === 'status'
      ? this.lifecycleCounts().find((item) =>
        item.label.toLocaleLowerCase() === selection.label.toLocaleLowerCase())?.status ?? selection.label
      : selection.label;
    this.chartFilter.set({ kind, value });
  }

  openDetails(project: ProjectRequest): void {
    this.notice.set('');
    this.error.set('');
    this.financialMilestoneId.set(null);
    this.resetMilestoneForm();
    this.selectedProject.set(project);
  }

  closeDetails(): void {
    this.selectedProject.set(null);
    this.error.set('');
    this.financialMilestoneId.set(null);
    this.resetMilestoneForm();
  }

  nextStatuses(project: ProjectRequest): ProjectStatus[] {
    return ADMIN_TRANSITIONS[project.status] ?? [];
  }

  async changeStatus(project: ProjectRequest, status: ProjectStatus): Promise<void> {
    await this.performSave(
      () => this.api.transitionProjectStatus(project.requestId, status),
      `Project status updated to ${this.statusLabel(status)}.`,
    );
  }

  async createMilestone(event: Event): Promise<void> {
    event.preventDefault();
    const project = this.selectedProject();
    if (!project) return;
    const payload: ProjectMilestoneInput = {
      title: this.milestoneForm.title.trim(),
      plannedStart: this.milestoneForm.plannedStart || null,
      dueDate: this.milestoneForm.dueDate,
      leadEngineerName: this.milestoneForm.leadEngineerName.trim() || null,
      budgetAmount: this.milestoneForm.budgetAmount,
      materialCost: this.milestoneForm.materialCost,
      partnerPayout: this.milestoneForm.partnerPayout,
      billedAmount: this.milestoneForm.billedAmount,
      clientSignoffStatus: this.milestoneForm.clientSignoffStatus,
    };
    await this.performSave(
      () => this.api.createProjectMilestone(project.requestId, payload),
      'Milestone added to the project plan.',
    );
    if (!this.error()) {
      this.resetMilestoneForm();
    }
  }

  beginFinancialEdit(milestone: ProjectMilestone): void {
    this.financialMilestoneId.set(milestone.id);
    this.financialForm.materialCost = milestone.materialCost;
    this.financialForm.partnerPayout = milestone.partnerPayout;
    this.financialForm.billedAmount = milestone.billedAmount;
  }

  async saveFinancials(project: ProjectRequest, milestone: ProjectMilestone, event: Event): Promise<void> {
    event.preventDefault();
    await this.updateMilestone(project, milestone, {
      materialCost: this.financialForm.materialCost,
      partnerPayout: this.financialForm.partnerPayout,
      billedAmount: this.financialForm.billedAmount,
    });
    if (!this.error()) this.financialMilestoneId.set(null);
  }

  async updateMilestone(project: ProjectRequest, milestone: ProjectMilestone, changes: ProjectMilestoneInput): Promise<void> {
    await this.performSave(
      () => this.api.updateProjectMilestone(project.requestId, milestone.id, changes),
      'Milestone details saved.',
    );
  }

  projectProgress(project: ProjectRequest): number {
    if (!project.milestones.length) return 0;
    return Math.round(project.milestones.filter((milestone) => milestone.status === 'completed').length /
      project.milestones.length * 100);
  }

  ganttPosition(project: ProjectRequest): { left: number; width: number } {
    const window = this.ganttWindow();
    if (!window || !project.milestones.length) return { left: 0, width: 0 };
    const start = Date.parse(`${window.start}T00:00:00Z`);
    const end = Date.parse(`${window.end}T00:00:00Z`);
    const span = Math.max(86_400_000, end - start);
    const projectStart = Math.min(...project.milestones
      .map((milestone) => Date.parse(`${(milestone.plannedStart || milestone.dueDate)}T00:00:00Z`))
      .filter(Number.isFinite));
    const projectEnd = Math.max(...project.milestones
      .map((milestone) => Date.parse(`${milestone.dueDate}T00:00:00Z`))
      .filter(Number.isFinite));
    return {
      left: Math.max(0, ((projectStart - start) / span) * 100),
      width: Math.max(3, ((projectEnd - projectStart) / span) * 100),
    };
  }

  statusLabel(status: string): string {
    return status.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
  }

  statusClass(status: string): string {
    if (['completed', 'approved'].includes(status)) return 'ok';
    if (['in_progress', 'under_review'].includes(status)) return 'info';
    if (['cancelled', 'clarification_required'].includes(status)) return 'warn';
    return 'neutral';
  }

  currencyLabel(value: number | null, currency = 'INR'): string {
    if (value === null || !Number.isFinite(value)) return 'Not recorded';
    const formatted = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value);
    return currency === 'INR' ? `₹${formatted}` : `${currency} ${formatted}`;
  }

  dateLabel(value: string | null): string {
    if (!value) return 'Not scheduled';
    const date = new Date(`${value.slice(0, 10)}T00:00:00`);
    return Number.isNaN(date.getTime()) ? 'Not scheduled' : date.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  hasMilestoneCosts(project: ProjectRequest): boolean {
    return project.milestones.some((milestone) => milestone.materialCost !== null || milestone.partnerPayout !== null);
  }

  isAtRisk(project: ProjectRequest): boolean {
    if (CLOSED_STATUSES.includes(project.status)) return false;
    const today = new Date().toISOString().slice(0, 10);
    return project.status === 'clarification_required' ||
      project.milestones.some((milestone) =>
        milestone.status === 'blocked' ||
        (milestone.status !== 'completed' && milestone.dueDate < today));
  }

  hasMaterialHold(project: ProjectRequest): boolean {
    return ['true', 'yes', '1', 'on_hold', 'blocked'].includes(
      String(project.details['material_hold'] ?? '').trim().toLowerCase(),
    );
  }

  needsSignoff(project: ProjectRequest): boolean {
    return project.milestones.some((milestone) => milestone.clientSignoffStatus === 'pending');
  }

  isHighValue(project: ProjectRequest): boolean {
    return project.currency === 'INR' && (project.value ?? 0) >= 1_000_000;
  }

  healthLabel(project: ProjectRequest): string {
    if (this.isAtRisk(project) || this.hasMaterialHold(project)) return 'At risk';
    if (project.milestones.some((milestone) => milestone.status !== 'completed' &&
        milestone.dueDate <= new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10))) return 'Watch';
    return 'Healthy';
  }

  chartFilterLabel(): string {
    const filter = this.chartFilter();
    return filter ? `${filter.kind}: ${filter.value}` : '';
  }

  private recordedFinancials(projects: ProjectRequest[]): { revenue: number; costs: number; matches: number } {
    let revenue = 0;
    let costs = 0;
    let matches = 0;
    for (const project of projects) {
      if (project.currency !== 'INR') continue;
      for (const milestone of project.milestones) {
        const cost = (milestone.materialCost ?? 0) + (milestone.partnerPayout ?? 0);
        if (milestone.billedAmount === null ||
            (milestone.materialCost === null && milestone.partnerPayout === null)) continue;
        revenue += milestone.billedAmount;
        costs += cost;
        matches += 1;
      }
    }
    return { revenue, costs, matches };
  }

  private async performSave(save: () => Promise<unknown>, success: string): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.notice.set('');
    this.error.set('');
    try {
      await save();
      const loaded = await this.ops.loadProjects();
      if (!loaded) throw new Error('The saved project could not be refreshed.');
      const selectedId = this.selectedProject()?.requestId;
      if (selectedId) {
        this.selectedProject.set(this.projects().find((project) => project.requestId === selectedId) ?? null);
      }
      this.notice.set(success);
    } catch (error) {
      this.error.set(this.api.errorMessage(error, 'The project update could not be saved.'));
    } finally {
      this.saving.set(false);
    }
  }

  private resetMilestoneForm(): void {
    this.milestoneForm.title = '';
    this.milestoneForm.plannedStart = '';
    this.milestoneForm.dueDate = '';
    this.milestoneForm.leadEngineerName = '';
    this.milestoneForm.budgetAmount = null;
    this.milestoneForm.materialCost = null;
    this.milestoneForm.partnerPayout = null;
    this.milestoneForm.billedAmount = null;
    this.milestoneForm.clientSignoffStatus = 'pending';
  }
}
