import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { OperationsService } from '../../../../core/services/operations.service';
import type { AnalyticsEvent } from '../../../../core/services/operations.service';
import { AdminChart } from '../../../../shared/admin-chart/admin-chart';

type CategoryId = AnalyticsEvent['category'];
type CategoryFilter = CategoryId | 'all';
type RangePreset = '24h' | '7d' | '30d' | '90d' | '12m' | 'custom';
type Granularity = 'auto' | 'hour' | 'day' | 'week' | 'month';
type Comparison = 'previous' | 'last-year';
type Trend = 'up' | 'down' | 'flat';

interface DateRange {
  start: number;
  end: number;
}

interface CategoryOption {
  id: CategoryId;
  label: string;
}

interface CategorySummary extends CategoryOption {
  revenue: number;
  refunds: number;
  activity: number;
  transactions: number;
  payout: number;
  net: number;
  share: number;
  change: number | null;
  slaCompliance: number | null;
  slaBreaches: number;
}

interface BucketPoint {
  key: number;
  label: string;
  detail: string;
  revenue: number;
  paidPayout: number;
  refunds: number;
  created: number;
  completed: number;
  breaches: number;
}

interface PeriodMetrics {
  grossRevenue: number;
  refunds: number;
  netRevenue: number;
  payout: number;
  paidPayout: number;
  createdJobs: number;
  completedJobs: number;
  closureRate: number;
  averageTransaction: number;
  slaCompliance: number | null;
  slaBreaches: number;
  averageDelay: number | null;
  mttr: number | null;
  dispatchTime: number | null;
  categories: CategorySummary[];
  points: BucketPoint[];
  activityEvents: AnalyticsEvent[];
  revenueEvents: AnalyticsEvent[];
}

interface Kpi {
  label: string;
  value: string;
  detail: string;
  icon: string;
  trend: Trend;
}

interface PartnerSummary {
  id: string;
  name: string;
  rating: number | null;
  jobs: number;
  completed: number;
  revenue: number;
  payout: number;
  slaCompliance: number | null;
}

interface RankedValue {
  label: string;
  count: number;
}

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CHART_POINTS = 60;

const CATEGORIES: CategoryOption[] = [
  { id: 'SVC', label: 'Service (SVC)' },
  { id: 'REP', label: 'Repair (REP)' },
  { id: 'PANEL', label: 'Panels (PANEL)' },
  { id: 'DEL', label: 'Delivery (DEL)' },
  { id: 'AMC', label: 'AMC' },
  { id: 'ORDERS', label: 'Orders' },
  { id: 'OTHER', label: 'Unmapped' },
];

const RANGE_PRESETS: Array<{ id: RangePreset; label: string }> = [
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: '12m', label: '12 months' },
  { id: 'custom', label: 'Custom' },
];

const GRANULARITIES: Array<{ id: Granularity; label: string }> = [
  { id: 'auto', label: 'Automatic' },
  { id: 'hour', label: 'Hourly' },
  { id: 'day', label: 'Daily' },
  { id: 'week', label: 'Weekly' },
  { id: 'month', label: 'Monthly' },
];

const COMPARISONS: Array<{ id: Comparison; label: string }> = [
  { id: 'previous', label: 'Previous period' },
  { id: 'last-year', label: 'Same period last year' },
];

function istParts(date: Date): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((value) => value.type === type)?.value ?? 0);
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour') };
}

function dateInputValue(date: Date): string {
  const { year, month, day } = istParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDateInput(value: string, endOfDay: boolean): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const localMidnight = Date.UTC(year, month - 1, day);
  const check = new Date(localMidnight);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day) return null;
  return localMidnight - IST_OFFSET_MS + (endOfDay ? DAY_MS - 1 : 0);
}

function shiftIstYear(timestamp: number, years: number): number {
  const shifted = new Date(timestamp + IST_OFFSET_MS);
  shifted.setUTCFullYear(shifted.getUTCFullYear() + years);
  return shifted.getTime() - IST_OFFSET_MS;
}

function startOfBucket(timestamp: number, granularity: Exclude<Granularity, 'auto'>): number {
  const { year, month, day, hour } = istParts(new Date(timestamp));
  const bucket = new Date(Date.UTC(year, month - 1, day, granularity === 'hour' ? hour : 0));
  if (granularity === 'week') {
    bucket.setUTCDate(bucket.getUTCDate() - ((bucket.getUTCDay() + 6) % 7));
  } else if (granularity === 'month') {
    bucket.setUTCDate(1);
  }
  return bucket.getTime() - IST_OFFSET_MS;
}

function nextBucket(timestamp: number, granularity: Exclude<Granularity, 'auto'>): number {
  const local = new Date(timestamp + IST_OFFSET_MS);
  if (granularity === 'hour') local.setUTCHours(local.getUTCHours() + 1);
  if (granularity === 'day') local.setUTCDate(local.getUTCDate() + 1);
  if (granularity === 'week') local.setUTCDate(local.getUTCDate() + 7);
  if (granularity === 'month') local.setUTCMonth(local.getUTCMonth() + 1);
  return local.getTime() - IST_OFFSET_MS;
}

function dateInside(timestamp: string | null | undefined, range: DateRange): boolean {
  if (!timestamp) return false;
  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) && value >= range.start && value <= range.end;
}

function slaObservedInRange(event: AnalyticsEvent, range: DateRange): boolean {
  if (!event.slaDueAt || event.slaBreached === null) return false;
  if (event.status === 'completed') return dateInside(event.completedAt, range);
  return event.slaBreached === true && dateInside(event.slaBreachAt || event.activityAt, range);
}

function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  if (typeof value === 'string' && /^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

@Component({
  selector: 'app-analytics-page',
  imports: [AdminChart],
  templateUrl: './analytics-page.html',
  styleUrl: './analytics-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnalyticsPage {
  readonly operations = inject(OperationsService);
  private readonly now = Date.now();

  readonly rangePresets = RANGE_PRESETS;
  readonly granularityOptions = GRANULARITIES;
  readonly comparisonOptions = COMPARISONS;
  readonly categoryOptions: Array<{ id: CategoryFilter; label: string }> = [
    { id: 'all', label: 'All categories' },
    ...CATEGORIES,
  ];

  readonly selectedPreset = signal<RangePreset>('30d');
  readonly selectedCategory = signal<CategoryFilter>('all');
  readonly selectedGranularity = signal<Granularity>('auto');
  readonly comparison = signal<Comparison>('previous');
  readonly activeAmcOnly = signal(false);
  readonly selectedPartner = signal<string | null>(null);
  readonly startDate = signal(dateInputValue(new Date(this.now - 30 * DAY_MS)));
  readonly endDate = signal(dateInputValue(new Date(this.now)));
  readonly maxDate = dateInputValue(new Date(this.now));

  readonly currentRange = computed<DateRange | null>(() => {
    if (this.selectedPreset() !== 'custom') return this.presetRange(this.selectedPreset());
    const start = parseDateInput(this.startDate(), false);
    const selectedEnd = parseDateInput(this.endDate(), true);
    if (start === null || selectedEnd === null || start > selectedEnd || start > this.now) return null;
    return { start, end: Math.min(selectedEnd, this.now) };
  });

  readonly rangeError = computed(() => {
    if (this.selectedPreset() !== 'custom') return '';
    const start = parseDateInput(this.startDate(), false);
    const end = parseDateInput(this.endDate(), true);
    if (start === null || end === null) return 'Choose both a start date and an end date.';
    if (start > end) return 'The start date must be on or before the end date.';
    if (start > this.now) return 'The selected range cannot be in the future.';
    return '';
  });

  readonly resolvedGranularity = computed<Exclude<Granularity, 'auto'>>(() => {
    const range = this.currentRange();
    if (!range) return 'day';
    const selected = this.selectedGranularity();
    if (selected !== 'auto' && this.bucketCount(range, selected) <= MAX_CHART_POINTS) return selected;
    const duration = range.end - range.start;
    if (duration <= 2 * DAY_MS) return 'hour';
    if (duration <= 45 * DAY_MS) return 'day';
    if (duration <= 180 * DAY_MS) return 'week';
    return 'month';
  });

  readonly previousRange = computed<DateRange | null>(() => {
    const range = this.currentRange();
    if (!range) return null;
    if (this.comparison() === 'last-year') {
      return {
        start: shiftIstYear(range.start, -1),
        end: shiftIstYear(range.end, -1),
      };
    }
    const duration = range.end - range.start + 1;
    return { start: range.start - duration, end: range.start - 1 };
  });

  readonly current = computed(() => {
    const range = this.currentRange();
    return range ? this.aggregate(range, this.resolvedGranularity()) : this.emptyMetrics();
  });

  readonly earningsChartDatasets = computed(() => [
    {
      label: 'Gross earnings',
      data: this.current().points.map((point) => point.revenue),
      backgroundColor: 'rgba(66, 232, 213, .72)',
      borderColor: '#42e8d5',
      borderRadius: 5,
    },
    {
      label: 'Refunds',
      data: this.current().points.map((point) => point.refunds),
      backgroundColor: 'rgba(255, 91, 126, .72)',
      borderColor: '#ff5b7e',
      borderRadius: 5,
    },
    {
      label: 'Partner payouts',
      data: this.current().points.map((point) => point.paidPayout),
      backgroundColor: 'rgba(180, 119, 255, .72)',
      borderColor: '#b477ff',
      borderRadius: 5,
    },
  ]);

  readonly jobsChartDatasets = computed(() => [
    {
      label: 'Created',
      data: this.current().points.map((point) => point.created),
      backgroundColor: 'rgba(88, 145, 255, .72)',
      borderColor: '#5891ff',
      borderRadius: 5,
    },
    {
      label: 'Completed',
      data: this.current().points.map((point) => point.completed),
      backgroundColor: 'rgba(66, 232, 180, .72)',
      borderColor: '#42e8b4',
      borderRadius: 5,
    },
    {
      label: 'SLA breaches',
      data: this.current().points.map((point) => point.breaches),
      backgroundColor: 'rgba(255, 91, 126, .72)',
      borderColor: '#ff5b7e',
      borderRadius: 5,
    },
  ]);

  readonly previous = computed(() => {
    const range = this.previousRange();
    return range ? this.aggregate(range, this.resolvedGranularity()) : this.emptyMetrics();
  });

  readonly categoryRows = computed(() => this.current().categories.map((category) => ({
    ...category,
    change: this.percentChange(
      category.revenue,
      this.previous().categories.find((item) => item.id === category.id)?.revenue ?? 0,
    ),
  })));

  readonly kpis = computed<Kpi[]>(() => {
    const current = this.current();
    const previous = this.previous();
    const revenueChange = this.percentChange(current.grossRevenue, previous.grossRevenue);
    const completionChange = this.percentChange(current.completedJobs, previous.completedJobs);
    const averageChange = this.percentChange(current.averageTransaction, previous.averageTransaction);
    const amc = this.operations.analyticsInsights();
    const netBeforeTax = current.netRevenue;
    return [
      {
        label: 'Gross earnings & payments',
        value: this.formatCurrency(current.grossRevenue),
        detail: `Net after recorded refunds/payouts (pre-tax): ${this.formatCurrency(netBeforeTax)} · Pending payouts: ${this.formatCurrency(amc.pendingPayouts)} · ${this.changeLabel(revenueChange)}`,
        icon: '₹',
        trend: this.trend(revenueChange),
      },
      {
        label: 'Jobs created / completed',
        value: `${current.createdJobs.toLocaleString('en-IN')} / ${current.completedJobs.toLocaleString('en-IN')}`,
        detail: `Closure rate ${this.formatPercent(current.closureRate)} · ${this.changeLabel(completionChange)} completed`,
        icon: '↗',
        trend: this.trend(completionChange),
      },
      {
        label: 'Average transaction',
        value: this.formatCurrency(current.averageTransaction),
        detail: `${current.revenueEvents.filter((event) => event.grossRevenue > 0).length.toLocaleString('en-IN')} recorded earning/payment events · ${this.changeLabel(averageChange)}`,
        icon: '≈',
        trend: this.trend(averageChange),
      },
      {
        label: 'SLA compliance',
        value: current.slaCompliance === null ? '—' : this.formatPercent(current.slaCompliance),
        detail: `${current.slaBreaches} breaches · Average delay ${this.formatMinutes(current.averageDelay)} · ${current.slaCompliance === null ? 'No eligible SLA timestamps' : this.changeLabel(this.percentChange(current.slaCompliance, previous.slaCompliance ?? 0))}`,
        icon: '◷',
        trend: 'flat',
      },
      {
        label: 'MTTR / dispatch time',
        value: this.formatMinutes(current.mttr),
        detail: `Average dispatch: ${this.formatMinutes(current.dispatchTime)} · Based on stored job timestamps`,
        icon: '⌁',
        trend: 'flat',
      },
      {
        label: 'AMC recurring value',
        value: amc.recurringAmcValueAvailable && amc.recurringAmcValue !== null
          ? this.formatCurrency(amc.recurringAmcValue)
          : 'Not connected',
        detail: `${amc.activeAmcContracts} active · ${amc.expiringAmcContracts} expiring in 30d · ${amc.openAmcRequests} open requests`,
        icon: '◈',
        trend: 'flat',
      },
    ];
  });

  readonly rangeLabel = computed(() => {
    const preset = this.selectedPreset();
    if (preset !== 'custom') return RANGE_PRESETS.find((item) => item.id === preset)?.label ?? '';
    const start = parseDateInput(this.startDate(), false);
    const end = parseDateInput(this.endDate(), true);
    if (start === null || end === null) return 'Custom date range';
    return `${this.formatDate(start)} – ${this.formatDate(end)}`;
  });

  readonly granularityLabel = computed(() =>
    GRANULARITIES.find((item) => item.id === this.resolvedGranularity())?.label ?? 'Daily',
  );

  readonly comparisonLabel = computed(() =>
    COMPARISONS.find((item) => item.id === this.comparison())?.label ?? 'Previous period',
  );

  readonly partners = computed<PartnerSummary[]>(() => {
    const range = this.currentRange();
    const grouped = new Map<string, PartnerSummary & { slaCount: number; slaOnTime: number }>();
    for (const event of this.filteredEvents()) {
      if (!event.partnerId) continue;
      const partner = grouped.get(event.partnerId) ?? {
        id: event.partnerId,
        name: event.partnerName || `Partner ${event.partnerId}`,
        rating: event.partnerRating,
        jobs: 0,
        completed: 0,
        revenue: 0,
        payout: 0,
        slaCompliance: null,
        slaCount: 0,
        slaOnTime: 0,
      };
      if (range && event.kind === 'job' && dateInside(event.activityAt, range)) {
        partner.jobs += 1;
      }
      if (range && event.kind === 'job' && dateInside(event.completedAt, range)) {
        partner.completed += 1;
      }
      if (range && event.kind === 'job' && slaObservedInRange(event, range)) {
        partner.slaCount += 1;
        if (event.slaBreached === false) partner.slaOnTime += 1;
      }
      if (range && dateInside(event.revenueAt, range)) {
        partner.revenue += event.grossRevenue;
        partner.payout += event.payoutAmount;
      }
      grouped.set(event.partnerId, partner);
    }
    return [...grouped.values()]
      .map(({ slaCount, slaOnTime, ...partner }) => ({
        ...partner,
        slaCompliance: slaCount ? (slaOnTime / slaCount) * 100 : null,
      }))
      .sort((a, b) => b.revenue - a.revenue || b.completed - a.completed)
      .slice(0, 10);
  });

  readonly topFaults = computed(() => this.rankValues(this.current().activityEvents, 'issue'));
  readonly topOems = computed(() => this.rankValues(this.current().activityEvents, 'oem'));
  readonly recentEvents = computed(() =>
    [...this.current().activityEvents]
      .sort((a, b) => new Date(b.activityAt).getTime() - new Date(a.activityAt).getTime())
      .slice(0, 20),
  );

  readonly selectedPartnerName = computed(() =>
    this.partners().find((partner) => partner.id === this.selectedPartner())?.name ?? '',
  );

  selectPreset(preset: RangePreset): void {
    this.selectedPreset.set(preset);
    this.selectedGranularity.set('auto');
    const range = this.presetRange(preset);
    if (range) {
      this.startDate.set(dateInputValue(new Date(range.start)));
      this.endDate.set(dateInputValue(new Date(range.end)));
    }
  }

  selectPresetFromEvent(event: Event): void {
    const value = this.selectValue(event);
    if (RANGE_PRESETS.some((item) => item.id === value)) this.selectPreset(value as RangePreset);
  }

  selectCategory(event: Event): void {
    const value = this.selectValue(event);
    if (value === 'all' || CATEGORIES.some((category) => category.id === value)) {
      this.selectedCategory.set(value as CategoryFilter);
      this.selectedPartner.set(null);
    }
  }

  selectGranularity(event: Event): void {
    const value = this.selectValue(event);
    if (GRANULARITIES.some((item) => item.id === value)) {
      this.selectedGranularity.set(value as Granularity);
    }
  }

  selectComparison(event: Event): void {
    const value = this.selectValue(event);
    if (value === 'previous' || value === 'last-year') this.comparison.set(value);
  }

  updateStartDate(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    this.startDate.set(target.value);
    this.selectedPreset.set('custom');
    this.selectedGranularity.set('auto');
  }

  updateEndDate(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    this.endDate.set(target.value);
    this.selectedPreset.set('custom');
    this.selectedGranularity.set('auto');
  }

  toggleActiveAmc(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) this.activeAmcOnly.set(target.checked);
  }

  granularityDisabled(granularity: Granularity): boolean {
    const range = this.currentRange();
    return granularity !== 'auto' &&
      (!range || this.bucketCount(range, granularity) > MAX_CHART_POINTS);
  }

  showAxisLabel(index: number): boolean {
    const length = this.current().points.length;
    if (length <= 8) return true;
    return index % Math.ceil(length / 8) === 0 || index === length - 1;
  }

  revenueHeight(value: number): number {
    const maximum = Math.max(...this.current().points.map((point) => point.revenue), 1);
    return value ? Math.max(3, Math.round((value / maximum) * 100)) : 0;
  }

  payoutHeight(value: number): number {
    const maximum = Math.max(...this.current().points.map((point) => point.paidPayout), 1);
    return value ? Math.max(3, Math.round((value / maximum) * 100)) : 0;
  }

  activityHeight(value: number): number {
    const maximum = Math.max(
      ...this.current().points.map((point) => Math.max(point.created, point.completed, point.breaches)),
      1,
    );
    return value ? Math.max(3, Math.round((value / maximum) * 100)) : 0;
  }

  formatCurrency(value: number): string {
    return `₹${Math.round(value).toLocaleString('en-IN')}`;
  }

  formatCompactCurrency(value: number): string {
    return `₹${new Intl.NumberFormat('en-IN', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)}`;
  }

  formatPercent(value: number): string {
    return `${value.toFixed(1)}%`;
  }

  formatMinutes(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return '—';
    if (value < 60) return `${Math.round(value)} min`;
    const hours = Math.floor(value / 60);
    const minutes = Math.round(value % 60);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  categoryLabel(id: CategoryFilter): string {
    if (id === 'all') return 'All categories';
    return CATEGORIES.find((category) => category.id === id)?.label ?? id;
  }

  formatDateTime(timestamp: string): string {
    const value = new Date(timestamp);
    return Number.isFinite(value.getTime())
      ? new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(value)
      : '—';
  }

  changeLabel(change: number | null): string {
    if (change === null) return 'New in this period';
    if (Math.abs(change) < 0.05) return 'No change vs comparison';
    return `${change > 0 ? '↑' : '↓'} ${Math.abs(change).toFixed(1)}% vs ${this.comparisonLabel().toLowerCase()}`;
  }

  pointTitle(point: BucketPoint): string {
    return `${point.detail}: ${this.formatCurrency(point.revenue)} gross · ${this.formatCurrency(point.refunds)} refunded · ${this.formatCurrency(point.paidPayout)} paid out`;
  }

  selectCategoryDrilldown(category: CategoryId): void {
    this.selectedCategory.set(category);
    this.selectedPartner.set(null);
  }

  selectPartnerDrilldown(partner: PartnerSummary): void {
    this.selectedPartner.set(partner.id);
  }

  clearDrilldown(): void {
    this.selectedPartner.set(null);
    this.selectedCategory.set('all');
  }

  exportCsv(): void {
    const rows: Array<Array<string | number | null>> = [
      ['Analytics report', this.rangeLabel()],
      ['Comparison', this.comparisonLabel()],
      ['Category', 'Gross earnings/payments', 'Refunds', 'Net after payouts', 'Activity volume', 'Transactions', 'Partner payout', 'Revenue share %', 'Change %'],
      ...this.categoryRows().map((category) => [
        category.label,
        category.revenue,
        category.refunds,
        category.net,
        category.activity,
        category.transactions,
        category.payout,
        category.share.toFixed(2),
        category.change === null ? '' : category.change.toFixed(2),
      ]),
      [],
      ['Event', 'Category', 'Event time (IST)', 'Type', 'Status', 'Partner / issue', 'Gross', 'Refund', 'Payout'],
      ...this.exportEvents().map((event) => [
        event.id,
        this.categoryLabel(event.category),
        this.formatDateTime(event.revenueAt || event.activityAt),
        event.kind,
        event.status,
        event.partnerName || event.issue || '',
        event.grossRevenue,
        event.refundAmount,
        event.payoutAmount,
      ]),
    ];
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `analytics-${dateInputValue(new Date(this.now))}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  exportPdf(): void {
    if (typeof window.print === 'function') window.print();
  }

  private aggregate(range: DateRange, granularity: Exclude<Granularity, 'auto'>): PeriodMetrics {
    const events = this.filteredEvents();
    const activityEvents = events.filter((event) =>
      event.kind !== 'earning' && dateInside(event.activityAt, range),
    );
    const revenueEvents = events.filter((event) => dateInside(event.revenueAt, range));
    const refundEvents = events.filter((event) => dateInside(event.refundAt, range));
    const operational = events.filter((event) => event.kind === 'job' || event.kind === 'repair-ticket');
    const completed = operational.filter((event) => dateInside(event.completedAt, range));
    const createdOperational = activityEvents.filter((event) =>
      event.kind === 'job' || event.kind === 'repair-ticket',
    );
    const eligibleSla = operational.filter((event) => slaObservedInRange(event, range));
    const breaches = eligibleSla.filter((event) => event.slaBreached === true);
    const onTime = eligibleSla.filter((event) => event.slaBreached === false);
    const delays = breaches.map((event) => event.delayMinutes).filter((value): value is number => value !== null);
    const mttrValues = completed.map((event) => event.mttrMinutes).filter((value): value is number => value !== null);
    const dispatchValues = activityEvents
      .filter((event) => event.kind === 'job')
      .map((event) => event.dispatchMinutes)
      .filter((value): value is number => value !== null);
    const grossRevenue = revenueEvents.reduce((total, event) => total + event.grossRevenue, 0);
    const refunds = refundEvents.reduce((total, event) => total + event.refundAmount, 0);
    const payout = revenueEvents.reduce((total, event) => total + event.payoutAmount, 0);
    const paidPayout = events
      .filter((event) => dateInside(event.payoutAt, range))
      .reduce((total, event) => total + event.paidPayout, 0);
    const transactions = revenueEvents.filter((event) => event.grossRevenue > 0).length;
    const categories = CATEGORIES.map((category) => {
      const categoryActivity = activityEvents.filter((event) => event.category === category.id).length;
      const categoryRevenueEvents = revenueEvents.filter((event) => event.category === category.id);
      const revenue = categoryRevenueEvents.reduce((total, event) => total + event.grossRevenue, 0);
      const categoryRefunds = refundEvents
        .filter((event) => event.category === category.id)
        .reduce((total, event) => total + event.refundAmount, 0);
      const categorySla = operational.filter((event) =>
        event.category === category.id && event.kind === 'job' && slaObservedInRange(event, range),
      );
      const categoryOnTime = categorySla.filter((event) => event.slaBreached === false).length;
      return {
        ...category,
        revenue,
        refunds: categoryRefunds,
        activity: categoryActivity,
        transactions: categoryRevenueEvents.filter((event) => event.grossRevenue > 0).length,
        payout: categoryRevenueEvents.reduce((total, event) => total + event.payoutAmount, 0),
        net: revenue - categoryRefunds -
          categoryRevenueEvents.reduce((total, event) => total + event.payoutAmount, 0),
        share: grossRevenue ? (revenue / grossRevenue) * 100 : 0,
        change: null,
        slaCompliance: categorySla.length ? (categoryOnTime / categorySla.length) * 100 : null,
        slaBreaches: categorySla.filter((event) => event.slaBreached === true).length,
      };
    });

    const points = this.createBuckets(range, granularity);
    const pointByStart = new Map(points.map((point) => [point.key, point]));
    for (const event of activityEvents) {
      const date = new Date(event.activityAt).getTime();
      const point = pointByStart.get(startOfBucket(date, granularity));
      if (!point) continue;
      if (event.kind === 'job' || event.kind === 'repair-ticket') point.created += 1;
    }
    for (const event of completed) {
      const point = pointByStart.get(startOfBucket(new Date(event.completedAt!).getTime(), granularity));
      if (point) point.completed += 1;
    }
    for (const event of breaches) {
      const breachAt = event.slaBreachAt || event.completedAt || event.activityAt;
      const point = pointByStart.get(startOfBucket(new Date(breachAt).getTime(), granularity));
      if (point) point.breaches += 1;
    }
    for (const event of revenueEvents) {
      if (!event.revenueAt) continue;
      const point = pointByStart.get(startOfBucket(new Date(event.revenueAt).getTime(), granularity));
      if (point) point.revenue += event.grossRevenue;
    }
    for (const event of refundEvents) {
      if (!event.refundAt) continue;
      const point = pointByStart.get(startOfBucket(new Date(event.refundAt).getTime(), granularity));
      if (point) point.refunds += event.refundAmount;
    }
    for (const event of events) {
      if (!dateInside(event.payoutAt, range) || !event.payoutAt) continue;
      const point = pointByStart.get(startOfBucket(new Date(event.payoutAt).getTime(), granularity));
      if (point) point.paidPayout += event.paidPayout;
    }

    return {
      grossRevenue,
      refunds,
      netRevenue: grossRevenue - refunds - payout,
      payout,
      paidPayout,
      createdJobs: createdOperational.length,
      completedJobs: completed.length,
      closureRate: createdOperational.length
        ? (createdOperational.filter((event) => dateInside(event.completedAt, range)).length /
          createdOperational.length) * 100
        : 0,
      averageTransaction: transactions ? grossRevenue / transactions : 0,
      slaCompliance: eligibleSla.length ? (onTime.length / eligibleSla.length) * 100 : null,
      slaBreaches: breaches.length,
      averageDelay: delays.length ? delays.reduce((sum, value) => sum + value, 0) / delays.length : null,
      mttr: mttrValues.length ? mttrValues.reduce((sum, value) => sum + value, 0) / mttrValues.length : null,
      dispatchTime: dispatchValues.length
        ? dispatchValues.reduce((sum, value) => sum + value, 0) / dispatchValues.length : null,
      categories: categories.map((category) => ({
        ...category,
        change: null,
      })),
      points,
      activityEvents,
      revenueEvents,
    };
  }

  private filteredEvents(): AnalyticsEvent[] {
    return this.operations.analyticsRecords().filter((event) =>
      (this.selectedCategory() === 'all' || event.category === this.selectedCategory()) &&
      (!this.activeAmcOnly() || event.activeAmc === true) &&
      (!this.selectedPartner() || event.partnerId === this.selectedPartner()),
    );
  }

  private createBuckets(range: DateRange, granularity: Exclude<Granularity, 'auto'>): BucketPoint[] {
    const points: BucketPoint[] = [];
    for (
      let cursor = startOfBucket(range.start, granularity);
      cursor <= range.end && points.length < MAX_CHART_POINTS;
      cursor = nextBucket(cursor, granularity)
    ) {
      points.push({
        key: cursor,
        label: this.bucketLabel(cursor, granularity),
        detail: this.formatBucketDetail(cursor, granularity),
        revenue: 0,
        paidPayout: 0,
        refunds: 0,
        created: 0,
        completed: 0,
        breaches: 0,
      });
    }
    return points;
  }

  private bucketCount(range: DateRange, granularity: Exclude<Granularity, 'auto'>): number {
    let count = 0;
    for (
      let cursor = startOfBucket(range.start, granularity);
      cursor <= range.end && count <= MAX_CHART_POINTS;
      cursor = nextBucket(cursor, granularity)
    ) count += 1;
    return count;
  }

  private presetRange(preset: RangePreset): DateRange | null {
    if (preset === 'custom') return null;
    let start = this.now;
    if (preset === '24h') start -= DAY_MS;
    if (preset === '7d') start -= 7 * DAY_MS;
    if (preset === '30d') start -= 30 * DAY_MS;
    if (preset === '90d') start -= 90 * DAY_MS;
    if (preset === '12m') start = shiftIstYear(this.now, -1);
    return { start, end: this.now };
  }

  private emptyMetrics(): PeriodMetrics {
    return {
      grossRevenue: 0,
      refunds: 0,
      netRevenue: 0,
      payout: 0,
      paidPayout: 0,
      createdJobs: 0,
      completedJobs: 0,
      closureRate: 0,
      averageTransaction: 0,
      slaCompliance: null,
      slaBreaches: 0,
      averageDelay: null,
      mttr: null,
      dispatchTime: null,
      categories: CATEGORIES.map((category) => ({
        ...category,
        revenue: 0,
        refunds: 0,
        activity: 0,
        transactions: 0,
        payout: 0,
        net: 0,
        share: 0,
        change: null,
        slaCompliance: null,
        slaBreaches: 0,
      })),
      points: [],
      activityEvents: [],
      revenueEvents: [],
    };
  }

  private rankValues(events: AnalyticsEvent[], key: 'issue' | 'oem'): RankedValue[] {
    const counts = new Map<string, number>();
    for (const event of events) {
      if (event.kind !== 'job' && event.kind !== 'repair-ticket') continue;
      const label = event[key]?.trim();
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, 5);
  }

  private exportEvents(): AnalyticsEvent[] {
    const events = new Map<string, AnalyticsEvent>();
    for (const event of [...this.current().activityEvents, ...this.current().revenueEvents]) {
      events.set(event.id, event);
    }
    return [...events.values()]
      .sort((a, b) => new Date(b.revenueAt || b.activityAt).getTime() -
        new Date(a.revenueAt || a.activityAt).getTime())
      .slice(0, 100);
  }

  private selectValue(event: Event): string {
    return event.target instanceof HTMLSelectElement ? event.target.value : '';
  }

  private bucketLabel(timestamp: number, granularity: Exclude<Granularity, 'auto'>): string {
    const { year, month, day, hour } = istParts(new Date(timestamp));
    if (granularity === 'hour') return `${String(hour).padStart(2, '0')}:00`;
    if (granularity === 'month') {
      return new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' })
        .format(new Date(Date.UTC(year, month - 1, 1)));
    }
    return String(day);
  }

  private formatBucketDetail(timestamp: number, granularity: Exclude<Granularity, 'auto'>): string {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: granularity === 'month' ? 'numeric' : undefined,
      ...(granularity === 'hour' ? { hour: '2-digit', minute: '2-digit' } : {}),
    }).format(new Date(timestamp));
  }

  private formatDate(timestamp: number): string {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(timestamp));
  }

  private percentChange(current: number, previous: number | null): number | null {
    if (previous === null) return null;
    if (previous === 0) return current === 0 ? 0 : null;
    return ((current - previous) / previous) * 100;
  }

  private trend(change: number | null): Trend {
    if (change === null || change === 0) return 'flat';
    return change > 0 ? 'up' : 'down';
  }
}
