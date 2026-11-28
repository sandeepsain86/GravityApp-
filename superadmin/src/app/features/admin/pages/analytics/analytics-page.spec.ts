import { TestBed } from '@angular/core/testing';
import type { AnalyticsEvent, AnalyticsInsights } from '../../../../core/services/operations.service';
import { OperationsService } from '../../../../core/services/operations.service';
import { AnalyticsPage } from './analytics-page';

const now = Date.now();

function record(overrides: Partial<AnalyticsEvent>): AnalyticsEvent {
  const at = new Date(now - 60_000).toISOString();
  return {
    id: 'job:1',
    at,
    activityAt: at,
    revenueAt: at,
    amount: 1200,
    grossRevenue: 1200,
    refundAmount: 0,
    refundAt: null,
    payoutAmount: 700,
    pendingPayout: 0,
    paidPayout: 700,
    payoutAt: at,
    category: 'SVC',
    kind: 'job',
    status: 'completed',
    completedAt: at,
    assignedAt: new Date(now - 120_000).toISOString(),
    slaDueAt: new Date(now + 60_000).toISOString(),
    slaBreachAt: null,
    slaBreached: false,
    delayMinutes: null,
    mttrMinutes: 10,
    dispatchMinutes: 1,
    partnerId: 'partner-1',
    partnerName: 'North Services',
    partnerRating: 4.8,
    activeAmc: true,
    issue: 'Pump pressure low',
    oem: 'Nova pump',
    ...overrides,
  };
}

const insights: AnalyticsInsights = {
  pendingPayouts: 350,
  activeAmcContracts: 3,
  expiringAmcContracts: 1,
  openAmcRequests: 2,
  recurringAmcValue: null,
  recurringAmcValueAvailable: false,
  invoiceDataAvailable: false,
  taxDataAvailable: false,
  lowStockItems: [],
};

describe('AnalyticsPage', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AnalyticsPage],
      providers: [{
        provide: OperationsService,
        useValue: {
          sourceStatus: () => 'connected',
          loadErrors: () => ({}),
          analyticsInsights: () => insights,
          analyticsRecords: () => [
            record({}),
            record({
              id: 'repair:2',
              at: new Date(now - 180_000).toISOString(),
              activityAt: new Date(now - 180_000).toISOString(),
              revenueAt: null,
              amount: 0,
              grossRevenue: 0,
              refundAmount: 0,
              refundAt: null,
              payoutAmount: 0,
              paidPayout: 0,
              payoutAt: null,
              category: 'REP',
              kind: 'repair-ticket',
              status: 'open',
              completedAt: null,
              assignedAt: null,
              slaDueAt: null,
              slaBreachAt: null,
              slaBreached: null,
              delayMinutes: null,
              mttrMinutes: null,
              dispatchMinutes: null,
              partnerId: null,
              partnerName: null,
              partnerRating: null,
              activeAmc: false,
              issue: 'Motor bearing noise',
              oem: null,
            }),
          ],
        },
      }],
    }).compileComponents();
  });

  it('only shows custom date inputs after selecting the custom range', () => {
    const fixture = TestBed.createComponent(AnalyticsPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const range = element.querySelector<HTMLSelectElement>('select[aria-label="Time range"]');

    expect(range).not.toBeNull();
    expect(range!.value).toBe('30d');
    expect(element.querySelectorAll('input[type="date"]')).toHaveLength(0);

    range!.value = 'custom';
    range!.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(element.querySelectorAll('input[type="date"]')).toHaveLength(2);
  });

  it('shows six KPI cards and filters activity drilldown by category', () => {
    const fixture = TestBed.createComponent(AnalyticsPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('.analytics-kpi')).toHaveLength(6);

    const category = element.querySelector<HTMLSelectElement>('select[aria-label="Category"]');
    expect(category).not.toBeNull();
    category!.value = 'REP';
    category!.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const rows = element.querySelectorAll('.drilldown-panel tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Motor bearing noise');
  });

  it('filters to jobs attributed to active AMC customers', () => {
    const fixture = TestBed.createComponent(AnalyticsPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const amcFilter = element.querySelector<HTMLInputElement>('.amc-filter input');

    expect(amcFilter).not.toBeNull();
    amcFilter!.click();
    fixture.detectChanges();

    const rows = element.querySelectorAll('.drilldown-panel tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('North Services');
  });
});
