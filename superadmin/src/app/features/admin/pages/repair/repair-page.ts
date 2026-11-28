import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval } from 'rxjs';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { OperationsService, type Partner, type RepairTicket } from '../../../../core/services/operations.service';
import { AdminChart, type ChartSelection } from '../../../../shared/admin-chart/admin-chart';
import { RepairWorkshopService } from './repair-workshop.service';

type RepairQueueFilter = 'all' | 'breached' | 'unassigned' | 'unassigned-2h' | 'amc' | 'parts';
type RepairQueueView = 'table' | 'board';
type RepairChartFilter =
  | { kind: 'stage'; value: string }
  | { kind: 'age'; value: string }
  | { kind: 'trend'; value: string; dataset: string }
  | { kind: 'brand' | 'partner'; value: string };

const STAGE_LABELS: Record<RepairTicket['stage'], string> = {
  draft: 'Draft',
  received: 'Received',
  diagnosis: 'Diagnosis',
  quote_approval: 'Quote approval',
  repairing: 'Repairing',
  qc_passed: 'QC passed',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const STATUS_LABELS: Record<string, string> = {
  estimate_required: 'Awaiting customer quote approval',
  approved: 'Customer approved',
  repair_in_progress: 'Repair in progress',
  ready: 'QC passed',
  returned: 'Delivered',
  completed: 'Completed',
  workshop_details_updated: 'Workshop details updated',
};

const WORKFLOW_STAGES: RepairTicket['stage'][] = [
  'received',
  'diagnosis',
  'quote_approval',
  'repairing',
  'qc_passed',
  'delivered',
];

const STAGE_ICONS: Record<RepairTicket['stage'], string> = {
  draft: 'doc',
  received: 'box',
  diagnosis: 'pulse',
  quote_approval: 'shield',
  repairing: 'tool',
  qc_passed: 'check',
  delivered: 'truck',
  cancelled: 'warn',
};

const AGING_BUCKETS = ['0–2d', '3–7d', '8–15d', '16–30d', '30+d'];

@Component({
  selector: 'app-repair-page',
  imports: [AdminChart],
  templateUrl: './repair-page.html',
  styleUrl: './repair-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RepairPage {
  readonly ops = inject(OperationsService);
  readonly auth = inject(AuthService);
  private readonly api = inject(AdminApiService);
  private readonly workshopApi = inject(RepairWorkshopService);

  readonly includeTestTickets = signal(false);
  readonly clockNow = signal(Date.now());
  readonly queueFilter = signal<RepairQueueFilter>('all');
  readonly queueView = signal<RepairQueueView>('table');
  readonly chartFilter = signal<RepairChartFilter | null>(null);
  readonly selectedId = signal<string | null>(null);
  readonly selectedTicketIds = signal<string[]>([]);
  readonly bulkPartnerId = signal('');
  readonly selectedRepair = computed(() =>
    this.ops.repairs().find((ticket) => ticket.id === this.selectedId()) ?? null,
  );
  readonly visibleRepairs = computed(() =>
    this.ops.repairs().filter((ticket) => this.includeTestTickets() || !this.isSandboxTicket(ticket)),
  );
  readonly activeTicketCount = computed(() =>
    this.visibleRepairs().filter((ticket) => this.isActive(ticket)).length,
  );
  readonly stageCounts = computed(() =>
    WORKFLOW_STAGES.map((stage) => {
      const count = this.visibleRepairs().filter((ticket) => ticket.stage === stage).length;
      const total = this.visibleRepairs().length;
      return {
        stage,
        count,
        icon: STAGE_ICONS[stage],
        percentage: total ? Math.round((count / total) * 100) : 0,
      };
    }),
  );
  readonly stageChartDatasets = computed(() => [{
    label: 'Repair tickets',
    data: this.stageCounts().map((item) => item.count),
    backgroundColor: ['#5891ff', '#42e8d5', '#ffbd4a', '#b477ff', '#42e8b4', '#8b7bff'],
    borderRadius: 7,
    borderSkipped: false,
  }]);
  readonly agingCounts = computed(() => {
    const counts = new Map(AGING_BUCKETS.map((bucket) => [bucket, 0]));
    for (const ticket of this.visibleRepairs().filter((entry) => this.isActive(entry))) {
      const age = this.ageDays(ticket);
      if (age === null) continue;
      const bucket = this.agingBucket(age);
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    return AGING_BUCKETS.map((label) => ({ label, count: counts.get(label) ?? 0 }));
  });
  readonly agingChartDatasets = computed(() => [{
    label: 'Active tickets',
    data: this.agingCounts().map((entry) => entry.count),
    backgroundColor: ['#16a36a', '#eab308', '#f97316', '#ea580c', '#dc2626'],
    borderRadius: 6,
    borderSkipped: false,
  }]);
  readonly trendSeries = computed(() => {
    const today = new Date();
    const dates = Array.from({ length: 30 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (29 - index));
      return date;
    });
    const keys = dates.map((date) => this.dateKey(date));
    const inflow = new Array<number>(keys.length).fill(0);
    const delivered = new Array<number>(keys.length).fill(0);
    const indexByDate = new Map(keys.map((key, index) => [key, index]));

    for (const ticket of this.visibleRepairs()) {
      const arrivalIndex = indexByDate.get(this.dateKey(ticket.inAt));
      if (arrivalIndex !== undefined) inflow[arrivalIndex]++;
      if (ticket.stage === 'delivered' && ticket.completedAt) {
        const deliveredIndex = indexByDate.get(this.dateKey(ticket.completedAt));
        if (deliveredIndex !== undefined) delivered[deliveredIndex]++;
      }
    }

    return {
      keys,
      labels: dates.map((date) => new Intl.DateTimeFormat('en-IN', {
        day: 'numeric',
        month: 'short',
      }).format(date)),
      inflow,
      delivered,
    };
  });
  readonly trendChartDatasets = computed(() => {
    const trend = this.trendSeries();
    return [
      {
        label: 'Arrivals',
        data: trend.inflow,
        borderColor: '#5840ef',
        backgroundColor: 'rgba(88, 64, 239, .12)',
        fill: true,
        tension: 0.35,
      },
      {
        label: 'Delivered',
        data: trend.delivered,
        borderColor: '#16a36a',
        backgroundColor: 'rgba(22, 163, 106, .1)',
        fill: true,
        tension: 0.35,
      },
    ];
  });
  readonly brandCounts = computed(() => this.groupCounts(
    this.visibleRepairs().filter((ticket) => this.isActive(ticket)),
    (ticket) => ticket.manufacturer.trim() || 'Unspecified',
  ));
  readonly brandChartDatasets = computed(() => [{
    label: 'Brand',
    data: this.brandCounts().map((entry) => entry.count),
    backgroundColor: ['#5840ef', '#e46dce', '#16a36a', '#f59e0b', '#0891b2', '#8b5cf6'],
    borderWidth: 0,
  }]);
  readonly partnerCounts = computed(() => this.groupCounts(
    this.visibleRepairs().filter((ticket) => this.isActive(ticket)),
    (ticket) => ticket.benchPartnerName || ticket.partner || 'Unassigned',
  ));
  readonly partnerChartDatasets = computed(() => [{
    label: 'Tickets',
    data: this.partnerCounts().map((entry) => entry.count),
    backgroundColor: '#42a5f5',
    borderRadius: 5,
    borderSkipped: false,
  }]);
  readonly executiveKpis = computed(() => {
    const tickets = this.visibleRepairs();
    const active = tickets.filter((ticket) => this.isActive(ticket));
    const critical = active.filter((ticket) => (this.ageDays(ticket) ?? 0) > 7).length;
    const completed = tickets
      .map((ticket) => this.turnaroundDays(ticket))
      .filter((days): days is number => days !== null);
    const qcTrackedDeliveries = tickets.filter((ticket) =>
      ticket.stage === 'delivered' && ticket.history.some((event) => ['ready', 'qc_passed'].includes(event.status)),
    );
    const firstTimeFixCount = qcTrackedDeliveries.filter((ticket) => {
      const firstQcIndex = ticket.history.findIndex((event) => ['ready', 'qc_passed'].includes(event.status));
      return !ticket.history.slice(firstQcIndex + 1).some((event) =>
        ['repair_in_progress', 'repairing'].includes(event.status),
      );
    }).length;
    const averageTat = completed.length
      ? `${(completed.reduce((sum, days) => sum + days, 0) / completed.length).toFixed(1)}d`
      : '—';
    const averageTatDays = completed.length
      ? completed.reduce((sum, days) => sum + days, 0) / completed.length
      : null;
    const firstTimeFixRate = qcTrackedDeliveries.length
      ? `${Math.round((firstTimeFixCount / qcTrackedDeliveries.length) * 100)}%`
      : '—';
    const quoteTickets = active.filter((ticket) => ticket.stage === 'quote_approval');
    const quotedValues = quoteTickets.filter((ticket) => ticket.cost !== null);
    const quoteValue = quotedValues.reduce((sum, ticket) => sum + (ticket.cost ?? 0), 0);
    const unassigned = active.filter((ticket) => this.isUnassigned(ticket)).length;

    return [
      {
        key: 'aging',
        label: 'Critical aging',
        value: String(critical),
        detail: 'Active tickets over 7 days',
        icon: 'warn',
        tone: critical ? 'danger' : 'success',
      },
      {
        key: 'tat',
        label: 'Average turnaround',
        value: averageTat,
        detail: completed.length ? `Target under 7 days · ${completed.length} delivered` : 'No completed TAT data',
        icon: 'clock',
        tone: averageTatDays !== null && averageTatDays >= 7 ? 'danger' : 'primary',
      },
      {
        key: 'quotes',
        label: 'Pending quote value',
        value: !quoteTickets.length || quotedValues.length ? this.currencyLabel(quoteValue) : '—',
        detail: quoteTickets.length
          ? `${quotedValues.length} of ${quoteTickets.length} estimates recorded`
          : 'No quotes awaiting approval',
        icon: 'doc',
        tone: 'warning',
      },
      {
        key: 'ftfr',
        label: 'First-time fix',
        value: firstTimeFixRate,
        detail: qcTrackedDeliveries.length
          ? `${qcTrackedDeliveries.length} delivered with QC history`
          : 'No completed QC history',
        icon: 'check',
        tone: 'neutral',
      },
      {
        key: 'unassigned',
        label: 'Unassigned queue',
        value: String(unassigned),
        detail: `${active.filter((ticket) => this.isUnassigned(ticket) && this.isUnassignedEscalated(ticket)).length} waiting over 2 hours`,
        icon: 'users',
        tone: unassigned ? 'danger' : 'success',
      },
    ];
  });
  readonly queueFilters = computed(() => {
    const tickets = this.visibleRepairs();
    const filters: Array<{ id: RepairQueueFilter; label: string }> = [
      { id: 'all', label: 'All' },
      { id: 'breached', label: 'SLA breached' },
      { id: 'unassigned', label: 'Unassigned' },
      { id: 'unassigned-2h', label: 'Unassigned · 2h+' },
      { id: 'amc', label: 'AMC covered' },
      { id: 'parts', label: 'Awaiting parts' },
    ];
    return filters.map((filter) => ({
      ...filter,
      count: filter.id === 'all'
        ? tickets.length
        : tickets.filter((ticket) => this.matchesQueueFilter(ticket, filter.id)).length,
    }));
  });
  readonly filteredRepairs = computed(() => {
    const filter = this.queueFilter();
    const chartFilter = this.chartFilter();
    return this.visibleRepairs().filter((ticket) =>
      (filter === 'all' || this.matchesQueueFilter(ticket, filter)) &&
      (!chartFilter || this.matchesChartFilter(ticket, chartFilter)),
    );
  });
  readonly selectableVisibleTickets = computed(() =>
    this.filteredRepairs().filter((ticket) => this.isActive(ticket)),
  );
  readonly selectedVisibleCount = computed(() =>
    this.selectableVisibleTickets().filter((ticket) => this.selectedTicketIds().includes(ticket.id)).length,
  );
  readonly allVisibleSelected = computed(() =>
    this.selectableVisibleTickets().length > 0 &&
    this.selectedVisibleCount() === this.selectableVisibleTickets().length,
  );
  readonly workflowStages = WORKFLOW_STAGES;
  readonly remarks = signal('');
  readonly error = signal('');
  readonly notice = signal('');
  readonly saving = signal(false);
  readonly estimatedCost = signal<number | null>(null);
  readonly quoteApproved = signal(false);
  readonly selectedPartSku = signal('');
  readonly selectedPartQuantity = signal(1);
  readonly benchPartnerId = signal('');
  readonly spareParts = signal<Array<{ sku: string; name: string; quantity: number }>>([]);

  constructor() {
    interval(60_000).pipe(takeUntilDestroyed()).subscribe(() => this.clockNow.set(Date.now()));
  }

  private isSandboxTicket(ticket: RepairTicket): boolean {
    if (ticket.testRecord) return true;
    return [
      ticket.ticketNumber,
      ticket.manufacturer,
      ticket.model,
      ticket.device,
      ticket.fault,
      ticket.symptoms,
      ticket.clientName,
    ].some((value) => value.split(/\s+/).some((token) => {
      const normalized = token.replace(/[^a-z]/gi, '').toLowerCase();
      return normalized.length >= 6 && new Set(normalized).size <= 3;
    }));
  }

  isActive(ticket: RepairTicket): boolean {
    return !['delivered', 'cancelled', 'draft'].includes(ticket.stage);
  }

  private isUnassigned(ticket: RepairTicket): boolean {
    return !ticket.partner && !ticket.benchPartnerId && !ticket.benchPartnerName;
  }

  isUnassignedEscalated(ticket: RepairTicket): boolean {
    const receivedAt = new Date(ticket.inAt).getTime();
    return this.isActive(ticket) && this.isUnassigned(ticket) &&
      Number.isFinite(receivedAt) && this.clockNow() - receivedAt >= 2 * 60 * 60_000;
  }

  isAmcCovered(ticket: RepairTicket): boolean {
    if (!/active|covered/i.test(ticket.amcStatus)) return false;
    if (!ticket.amcEndDate) return true;
    const endDate = new Date(ticket.amcEndDate).getTime();
    return !Number.isFinite(endDate) || endDate >= Date.now();
  }

  isAwaitingParts(ticket: RepairTicket): boolean {
    return (ticket.partRequests ?? []).some((part) => part.status === 'requested') ||
      ticket.spareParts.some((part) => {
      const stockItem = this.ops.inventory.find((item) => item.sku === part.sku);
      return stockItem !== undefined && stockItem.stock < part.quantity;
    });
  }

  private matchesQueueFilter(ticket: RepairTicket, filter: RepairQueueFilter): boolean {
    switch (filter) {
      case 'breached': return this.isActive(ticket) && (this.ageDays(ticket) ?? 0) > 7;
      case 'unassigned': return this.isActive(ticket) && this.isUnassigned(ticket);
      case 'unassigned-2h': return this.isUnassignedEscalated(ticket);
      case 'amc': return this.isAmcCovered(ticket);
      case 'parts': return this.isAwaitingParts(ticket);
      default: return true;
    }
  }

  private matchesChartFilter(ticket: RepairTicket, filter: RepairChartFilter): boolean {
    switch (filter.kind) {
      case 'stage': return this.stageLabel(ticket.stage) === filter.value;
      case 'age': {
        const age = this.ageDays(ticket);
        return this.isActive(ticket) && age !== null && this.agingBucket(age) === filter.value;
      }
      case 'trend':
        return filter.dataset === 'Arrivals'
          ? this.dateKey(ticket.inAt) === filter.value
          : ticket.stage === 'delivered' && this.dateKey(ticket.completedAt ?? '') === filter.value;
      case 'brand': return (ticket.manufacturer.trim() || 'Unspecified') === filter.value;
      case 'partner': return (ticket.benchPartnerName || ticket.partner || 'Unassigned') === filter.value;
    }
  }

  ageDays(ticket: RepairTicket): number | null {
    const receivedAt = new Date(ticket.inAt).getTime();
    if (!Number.isFinite(receivedAt)) return null;
    return Math.max(0, Math.floor((this.clockNow() - receivedAt) / 86_400_000));
  }

  private agingBucket(days: number): string {
    if (days <= 2) return AGING_BUCKETS[0];
    if (days <= 7) return AGING_BUCKETS[1];
    if (days <= 15) return AGING_BUCKETS[2];
    if (days <= 30) return AGING_BUCKETS[3];
    return AGING_BUCKETS[4];
  }

  private turnaroundDays(ticket: RepairTicket): number | null {
    if (ticket.stage !== 'delivered' || !ticket.completedAt) return null;
    const start = new Date(ticket.inAt).getTime();
    const end = new Date(ticket.completedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return (end - start) / 86_400_000;
  }

  private dateKey(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  currencyLabel(value: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(value);
  }

  private groupCounts(
    tickets: RepairTicket[],
    getLabel: (ticket: RepairTicket) => string,
  ): Array<{ label: string; count: number }> {
    const counts = new Map<string, number>();
    for (const ticket of tickets) {
      const label = getLabel(ticket);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts.size
      ? [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count)
      : [{ label: 'No tickets', count: 0 }];
  }

  ticketsForStage(stage: RepairTicket['stage']): RepairTicket[] {
    return this.filteredRepairs().filter((ticket) => ticket.stage === stage);
  }

  setQueueFilter(filter: RepairQueueFilter): void {
    this.queueFilter.set(filter);
    this.chartFilter.set(null);
  }

  clearQueueFilters(): void {
    this.queueFilter.set('all');
    this.chartFilter.set(null);
  }

  onChartSelect(kind: 'stage' | 'age' | 'trend' | 'brand' | 'partner', selection: ChartSelection): void {
    this.queueFilter.set('all');
    let filter: RepairChartFilter | null = null;
    if (kind === 'stage' && WORKFLOW_STAGES.some((stage) => this.stageLabel(stage) === selection.label)) {
      filter = { kind, value: selection.label };
    } else if (kind === 'age' && AGING_BUCKETS.includes(selection.label)) {
      filter = { kind, value: selection.label };
    } else if (kind === 'trend') {
      const date = this.trendSeries().keys[selection.dataIndex];
      if (date) filter = { kind, value: date, dataset: selection.datasetLabel };
    } else if (kind === 'brand' || kind === 'partner') {
      filter = { kind, value: selection.label };
    }
    this.chartFilter.set(filter);
  }

  stageLabel(stage: string): string {
    return STAGE_LABELS[stage as RepairTicket['stage']] ?? stage;
  }

  stagePillClass(stage: string): string {
    switch (stage) {
      case 'delivered': return 'ok';
      case 'qc_passed': return 'info';
      case 'repairing': return 'warn';
      case 'received': return 'muted';
      case 'cancelled': return 'muted';
      default: return 'info';
    }
  }

  statusLabel(status: string): string {
    return STATUS_LABELS[status] ?? status.replaceAll('_', ' ');
  }

  nextStage(ticket: RepairTicket): RepairTicket['stage'] | null {
    if (ticket.status === 'submitted') return 'received';
    if (ticket.status === 'received') return 'diagnosis';
    if (ticket.status === 'diagnosis') return 'quote_approval';
    if (ticket.status === 'approved') return 'repairing';
    if (ticket.status === 'repair_in_progress') return 'qc_passed';
    if (ticket.status === 'ready') return 'delivered';
    return null;
  }

  nextActionLabel(ticket: RepairTicket): string {
    if (ticket.stage === 'quote_approval' && ticket.status !== 'approved') {
      return 'Waiting for customer quote approval';
    }
    const next = this.nextStage(ticket);
    if (!next) return 'No further action available';
    const labels: Partial<Record<RepairTicket['stage'], string>> = {
      received: 'Mark received',
      diagnosis: 'Start diagnosis',
      quote_approval: 'Mark estimate required',
      repairing: 'Start repair',
      qc_passed: 'Mark delivered',
    };
    return labels[next] ?? `Move to ${this.stageLabel(next)}`;
  }

  ageLabel(timestamp: string): string {
    const created = new Date(timestamp).getTime();
    if (!Number.isFinite(created)) return 'Age unavailable';
    const minutes = Math.max(0, Math.floor((this.clockNow() - created) / 60_000));
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  tatLabel(ticket: RepairTicket): string {
    if (!ticket.inAt) return 'Received date unavailable';
    const received = new Date(ticket.inAt);
    if (!Number.isFinite(received.getTime())) return 'Received date unavailable';
    const now = new Date(this.clockNow());
    const elapsedDays = Math.max(0, Math.floor((now.getTime() - received.getTime()) / 86_400_000));
    const month = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(received);
    const stageName = STAGE_LABELS[ticket.stage] || ticket.stage;
    return `${month} ${received.getDate()} · ${elapsedDays}d in ${stageName}`;
  }

  benchPartners(): import('../../../../core/services/operations.service').Partner[] {
    const partners = typeof this.ops.partners === 'function'
      ? this.ops.partners()
      : this.ops.partners;
    return partners.filter((partner) =>
      partner.verified && (partner.type === 'repairing' || partner.type === 'service'),
    );
  }

  partnerLoad(partnerId: string): number {
    return this.ops.activeRepairs().filter((ticket) => ticket.benchPartnerId === partnerId).length;
  }

  recommendedPartner(ticket: RepairTicket): Partner | null {
    const ticketText = [
      ticket.manufacturer,
      ticket.model,
      ticket.device,
      ticket.serviceType,
      ticket.repairScope,
      ticket.fault,
    ].join(' ').toLocaleLowerCase();
    return [...this.benchPartners()].sort((left, right) => {
      const score = (partner: Partner): number => {
        const matches = (partner.specializations ?? []).filter((specialization) => {
          const value = specialization.toLocaleLowerCase().trim();
          return value.length > 2 && ticketText.includes(value);
        }).length;
        return matches * 100 +
          Number(partner.online) * 20 -
          Number(partner.busy) * 10 -
          this.partnerLoad(partner.id);
      };
      return score(right) - score(left) || left.name.localeCompare(right.name);
    })[0] ?? null;
  }

  inventoryStatus(item: { stock: number; low: number }): 'in-stock' | 'low-stock' | 'out-of-stock' {
    if (item.stock <= 0) return 'out-of-stock';
    return item.stock <= item.low ? 'low-stock' : 'in-stock';
  }

  inventoryItem(sku: string): { stock: number; low: number } | null {
    return this.ops.inventory.find((item) => item.sku === sku) ?? null;
  }

  coverageLabel(ticket: RepairTicket): string {
    return this.isAmcCovered(ticket)
      ? 'Under AMC · Free repair'
      : 'Out of warranty · Paid repair';
  }

  saveBenchAssignment(ticket: RepairTicket): Promise<void> {
    return this.updateWorkshop(ticket, { benchPartnerId: this.benchPartnerId() || null });
  }

  assignRecommendedPartner(ticket: RepairTicket): Promise<void> {
    const partner = this.recommendedPartner(ticket);
    if (!partner) {
      this.error.set('No verified repair or service partner is available in the connected directory.');
      return Promise.resolve();
    }
    this.benchPartnerId.set(partner.id);
    return this.updateWorkshop(ticket, { benchPartnerId: partner.id });
  }

  async requestSelectedPart(ticket: RepairTicket): Promise<void> {
    const item = this.ops.inventory.find((entry) => entry.sku === this.selectedPartSku());
    if (!item || this.saving()) return;
    await this.updateWorkshop(ticket, {
      partRequest: { sku: item.sku, quantity: this.selectedPartQuantity() },
    });
  }

  private async updateWorkshop(
    ticket: RepairTicket,
    changes: { benchPartnerId?: string | null; partRequest?: { sku: string; quantity: number } },
  ): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      await this.workshopApi.update(ticket.id, changes);
      const refreshed = await this.ops.refreshOperations('repair');
      this.notice.set(refreshed
        ? changes.partRequest
          ? 'Part request saved. Inventory is not reserved until repair starts.'
          : changes.benchPartnerId
            ? 'Verified partner assigned to this ticket.'
            : 'Partner assignment updated.'
        : 'Workshop update saved, but ticket data could not refresh. Reload the page to see the latest state.');
    } catch (error) {
      this.error.set(this.api.errorMessage(error, 'The workshop update could not be saved.'));
    } finally {
      this.saving.set(false);
    }
  }

  onEstimatedCost(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.estimatedCost.set(value ? Number(value) : null);
  }

  onQuoteApproval(event: Event): void {
    this.quoteApproved.set((event.target as HTMLInputElement).checked);
  }

  onBenchPartner(event: Event): void {
    this.benchPartnerId.set((event.target as HTMLSelectElement).value);
  }

  onPartSku(event: Event): void {
    this.selectedPartSku.set((event.target as HTMLSelectElement).value);
  }

  onPartQuantity(event: Event): void {
    this.selectedPartQuantity.set(Math.max(1, Number((event.target as HTMLInputElement).value) || 1));
  }

  addSelectedPart(): void {
    const item = this.ops.inventory.find((entry) => entry.sku === this.selectedPartSku());
    if (!item) return;
    const quantity = this.selectedPartQuantity();
    this.spareParts.update((parts) => {
      const existing = parts.find((part) => part.sku === item.sku);
      if (existing) {
        return parts.map((part) => part.sku === item.sku
          ? { ...part, quantity: part.quantity + quantity }
          : part);
      }
      return [...parts, { sku: item.sku, name: item.name, quantity }];
    });
  }

  removeSelectedPart(sku: string): void {
    this.spareParts.update((parts) => parts.filter((part) => part.sku !== sku));
  }

  dateLabel(timestamp: string | null): string {
    if (!timestamp) return 'Not recorded';
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return 'Not recorded';
    return new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  openDetails(ticket: RepairTicket): void {
    this.selectedId.set(ticket.id);
    this.remarks.set('');
    this.error.set('');
    this.notice.set('');
    this.estimatedCost.set(ticket.cost);
    this.quoteApproved.set(ticket.quoteApproved);
    this.spareParts.set(ticket.spareParts.length
      ? [...ticket.spareParts]
      : (ticket.partRequests ?? [])
        .filter((request) => request.status === 'requested')
        .map(({ sku, name, quantity }) => ({ sku, name, quantity })),
    );
    this.benchPartnerId.set(ticket.benchPartnerId || '');
  }

  closeDetails(): void {
    this.selectedId.set(null);
  }

  onIncludeTestChange(event: Event): void {
    this.includeTestTickets.set((event.target as HTMLInputElement).checked);
    this.selectedTicketIds.set([]);
  }

  toggleTicketSelection(id: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    if (checked && this.selectedTicketIds().length >= 100) {
      this.error.set('Bulk assignment supports up to 100 tickets at a time.');
      return;
    }
    this.selectedTicketIds.update((ids) =>
      checked ? [...new Set([...ids, id])] : ids.filter((entry) => entry !== id),
    );
  }

  toggleVisibleSelection(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const visibleIds = new Set(this.selectableVisibleTickets().map((ticket) => ticket.id));
    this.selectedTicketIds.update((ids) => {
      const remaining = ids.filter((id) => !visibleIds.has(id));
      return checked ? [...remaining, ...visibleIds].slice(0, 100) : remaining;
    });
    if (checked && this.selectableVisibleTickets().length > 100) {
      this.error.set('Bulk assignment supports up to 100 tickets at a time. The first 100 visible tickets were selected.');
    }
  }

  onBulkPartnerChange(event: Event): void {
    this.bulkPartnerId.set((event.target as HTMLSelectElement).value);
  }

  async assignSelectedToPartner(): Promise<void> {
    const references = this.selectedTicketIds();
    const partner = this.benchPartners().find((entry) => entry.id === this.bulkPartnerId());
    if (!references.length || !partner || this.saving()) return;

    this.saving.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      await this.workshopApi.assignMany(references, partner.id);
      const refreshed = await this.ops.refreshOperations('repair');
      this.selectedTicketIds.set([]);
      this.notice.set(refreshed
        ? `${references.length} ticket${references.length === 1 ? '' : 's'} assigned to ${partner.name}.`
        : 'Assignment saved, but ticket data could not refresh. Reload the page to see the latest state.');
    } catch (error) {
      this.error.set(this.api.errorMessage(error, 'Bulk partner assignment failed.'));
    } finally {
      this.saving.set(false);
    }
  }

  onRemarksChange(event: Event): void {
    this.remarks.set((event.target as HTMLTextAreaElement).value);
  }

  async advanceStage(ticket: RepairTicket): Promise<void> {
    const next = this.nextStage(ticket);
    if (!next || this.saving()) return;
    await this.advanceToStage(ticket, next);
  }

  async advanceToStage(ticket: RepairTicket, targetStage: RepairTicket['stage']): Promise<void> {
    if (this.saving()) return;
    if (targetStage === 'quote_approval' && (!this.estimatedCost() || this.estimatedCost()! <= 0)) {
      this.error.set('Enter an estimated cost before submitting the customer quote.');
      return;
    }
    if (targetStage === 'repairing' && ticket.status !== 'approved' && !this.quoteApproved()) {
      this.error.set('Customer quote approval is required before repair can start.');
      return;
    }
    if (targetStage === 'qc_passed' && !this.remarks().trim()) {
      this.error.set('Add a QC note before marking the repair as QC passed.');
      return;
    }
    const bench = this.benchPartners().find((partner) => partner.id === this.benchPartnerId());
    const details = {
      estimatedCost: this.estimatedCost() ?? undefined,
      quoteApproved: this.quoteApproved(),
      parts: this.spareParts(),
      benchPartnerId: bench?.id,
      benchPartnerName: bench?.name,
    };
    this.saving.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      const refreshed = await this.ops.transitionRepairStage(ticket.id, targetStage, this.remarks().trim(), details);
      this.remarks.set('');
      this.notice.set(refreshed
        ? `Ticket moved to ${this.stageLabel(targetStage)}.`
        : 'Stage saved, but ticket data could not refresh. Reload the page to see the latest state.');
    } catch (error) {
      this.error.set(this.api.errorMessage(error, 'The repair stage could not be changed.'));
    } finally {
      this.saving.set(false);
    }
  }
}
