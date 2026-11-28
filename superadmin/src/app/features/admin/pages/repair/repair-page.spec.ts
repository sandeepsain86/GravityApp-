import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { OperationsService, type Partner, type RepairTicket } from '../../../../core/services/operations.service';
import { RepairPage } from './repair-page';
import { RepairWorkshopService } from './repair-workshop.service';

function repair(overrides: Partial<RepairTicket> = {}): RepairTicket {
  return {
    id: 'repair-1',
    ticketNumber: 'RPR-1',
    device: 'Acme VFD-10',
    manufacturer: 'Acme',
    model: 'VFD-10',
    serialNumber: 'SN-1',
    assetNumber: 'ASSET-1',
    location: 'Plant 1',
    clientName: 'Acme Industries',
    siteName: 'Plant 1',
    amcStatus: 'active',
    amcEndDate: '2027-01-01',
    partner: null,
    stage: 'diagnosis',
    status: 'diagnosis',
    fault: 'F0001',
    symptoms: 'Overcurrent',
    serviceType: 'component_repair',
    repairScope: 'workshop',
    priority: 'urgent',
    requestedTurnaround: '2 days',
    inAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    updatedAt: null,
    completedAt: null,
    cost: null,
    estimateRequired: false,
    quoteApproved: false,
    spareParts: [],
    partRequests: [],
    benchPartnerId: null,
    benchPartnerName: null,
    diagnosisAt: null,
    testRecord: false,
    history: [],
    ...overrides,
  };
}

describe('RepairPage', () => {
  let repairs: ReturnType<typeof signal<RepairTicket[]>>;
  let partners: ReturnType<typeof signal<Partner[]>>;
  let transitionRepairStage: ReturnType<typeof vi.fn>;
  let updateRepairWorkshop: ReturnType<typeof vi.fn>;
  let assignMany: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    repairs = signal([repair(), repair({
      id: 'repair-test',
      ticketNumber: 'RPR-TEST-1',
      testRecord: true,
    })]);
    partners = signal([]);
    transitionRepairStage = vi.fn().mockResolvedValue(true);
    updateRepairWorkshop = vi.fn().mockResolvedValue(true);
    assignMany = vi.fn().mockResolvedValue(undefined);
    await TestBed.configureTestingModule({
      imports: [RepairPage],
      providers: [
        {
          provide: OperationsService,
          useValue: {
            repairs,
            inventory: [{ sku: 'PART-1', name: 'Power module', category: 'electrical', stock: 3, low: 1, supplier: null }],
            partners,
            activeRepairs: () => repairs().filter((ticket) => ticket.stage !== 'delivered'),
            loadErrors: signal({}),
            transitionRepairStage,
            refreshOperations: vi.fn().mockResolvedValue(true),
          },
        },
        { provide: RepairWorkshopService, useValue: { update: updateRepairWorkshop, assignMany } },
        { provide: AuthService, useValue: { canAccess: () => true } },
        { provide: AdminApiService, useValue: { errorMessage: (_error: unknown, fallback: string) => fallback } },
      ],
    }).compileComponents();
  });

  it('hides test tickets by default and includes them when the filter is enabled', () => {
    const fixture = TestBed.createComponent(RepairPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelectorAll('tbody tr')).toHaveLength(1);
    element.querySelector<HTMLInputElement>('.repair-test-filter input')!.click();
    fixture.detectChanges();
    expect(element.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('hides generated dummy device text unless sandbox tickets are enabled', () => {
    repairs.set([
      repair({ id: 'real-repair', ticketNumber: 'RPR-2026-000031' }),
      repair({
        id: 'dummy-repair',
        ticketNumber: 'RPR-2026-000030',
        manufacturer: 'Dhdrhdh',
        model: 'HDDHDHHDD',
        testRecord: false,
      }),
    ]);
    const fixture = TestBed.createComponent(RepairPage);
    fixture.detectChanges();
    const page = fixture.componentInstance;

    expect(page.visibleRepairs().map((ticket) => ticket.id)).toEqual(['real-repair']);
    page.includeTestTickets.set(true);
    expect(page.visibleRepairs().map((ticket) => ticket.id)).toEqual(['real-repair', 'dummy-repair']);
  });

  it('filters the actionable repair queue from lifecycle chart selections', () => {
    repairs.set([
      repair({ id: 'diagnosis-repair', stage: 'diagnosis' }),
      repair({ id: 'repairing-repair', stage: 'repairing' }),
    ]);
    const fixture = TestBed.createComponent(RepairPage);
    fixture.detectChanges();
    const page = fixture.componentInstance;

    page.onChartSelect('stage', {
      label: 'Diagnosis',
      datasetLabel: 'Repair tickets',
      dataIndex: 1,
      datasetIndex: 0,
    });

    expect(page.filteredRepairs().map((ticket) => ticket.id)).toEqual(['diagnosis-repair']);
  });

  it('flags and filters unassigned tickets waiting more than two hours', () => {
    repairs.set([
      repair({ id: 'escalated', inAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }),
      repair({ id: 'recent', inAt: new Date(Date.now() - 60 * 60_000).toISOString() }),
      repair({ id: 'assigned', benchPartnerId: 'bench-1', inAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }),
    ]);
    const page = TestBed.createComponent(RepairPage).componentInstance;

    expect(page.filteredRepairs().filter((ticket) => page.isUnassignedEscalated(ticket)).map((ticket) => ticket.id))
      .toEqual(['escalated']);
    page.setQueueFilter('unassigned-2h');
    expect(page.filteredRepairs().map((ticket) => ticket.id)).toEqual(['escalated']);
  });

  it('calculates aging, quote, turnaround, and first-time-fix KPIs from saved records', () => {
    const now = Date.now();
    repairs.set([
      repair({
        id: 'quote-repair',
        stage: 'quote_approval',
        status: 'estimate_required',
        cost: 2500,
        inAt: new Date(now - 10 * 86_400_000).toISOString(),
      }),
      repair({
        id: 'delivered-repair',
        stage: 'delivered',
        completedAt: new Date(now - 2 * 86_400_000).toISOString(),
        inAt: new Date(now - 11 * 86_400_000).toISOString(),
        partner: 'Bench One',
        history: [
          { status: 'ready', remarks: 'QC passed', at: null },
          { status: 'returned', remarks: 'Delivered', at: null },
        ],
      }),
      repair({
        id: 'rework-delivery',
        stage: 'delivered',
        completedAt: new Date(now - 2 * 86_400_000).toISOString(),
        inAt: new Date(now - 11 * 86_400_000).toISOString(),
        partner: 'Bench Two',
        history: [
          { status: 'ready', remarks: 'QC failed', at: null },
          { status: 'repair_in_progress', remarks: 'Rework', at: null },
          { status: 'ready', remarks: 'QC passed', at: null },
          { status: 'returned', remarks: 'Delivered', at: null },
        ],
      }),
    ]);
    const fixture = TestBed.createComponent(RepairPage);
    fixture.detectChanges();
    const metrics = fixture.componentInstance.executiveKpis();

    expect(metrics.find((metric) => metric.key === 'aging')?.value).toBe('1');
    expect(metrics.find((metric) => metric.key === 'tat')?.value).toBe('9.0d');
    expect(metrics.find((metric) => metric.key === 'quotes')?.value).toContain('2,500');
    expect(metrics.find((metric) => metric.key === 'ftfr')?.value).toBe('50%');
    expect(metrics.find((metric) => metric.key === 'unassigned')?.value).toBe('1');
  });

  it('allows stage changes only after customer quote approval and requires a QC note', async () => {
    const fixture = TestBed.createComponent(RepairPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    element.querySelector<HTMLButtonElement>('.repair-ticket-link')!.click();
    fixture.detectChanges();
    expect(element.querySelector('.repair-workflow-action')?.textContent).toContain('Mark estimate required');
    const cost = element.querySelector<HTMLInputElement>('input[type="number"]')!;
    cost.value = '2500';
    cost.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    element.querySelector<HTMLButtonElement>('.repair-workflow-action button')!.click();
    await fixture.whenStable();
    expect(transitionRepairStage).toHaveBeenCalledWith(
      'repair-1',
      'quote_approval',
      '',
      expect.objectContaining({ estimatedCost: 2500 }),
    );

    repairs.set([repair({ stage: 'quote_approval', status: 'estimate_required' })]);
    fixture.detectChanges();
    expect(element.querySelector('.repair-workflow-action')?.textContent).toContain('Waiting for customer quote approval');
    expect(element.querySelector('.repair-workflow-action button')).toBeNull();

    repairs.set([repair({ stage: 'repairing', status: 'repair_in_progress' })]);
    fixture.detectChanges();
    element.querySelector<HTMLButtonElement>('.repair-ticket-link')!.click();
    fixture.detectChanges();
    element.querySelector<HTMLButtonElement>('.repair-workflow-action button')!.click();
    fixture.detectChanges();
    expect(element.querySelector('.repair-message-error')?.textContent).toContain('Add a QC note');
    expect(transitionRepairStage).toHaveBeenCalledTimes(1);

    const note = element.querySelector<HTMLTextAreaElement>('#repair-transition-remarks')!;
    note.value = 'Power-on, load, and visual checks passed';
    note.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    element.querySelector<HTMLButtonElement>('.repair-workflow-action button')!.click();
    await fixture.whenStable();
    expect(transitionRepairStage).toHaveBeenLastCalledWith(
      'repair-1',
      'qc_passed',
      'Power-on, load, and visual checks passed',
      expect.objectContaining({ parts: [] }),
    );
  });

  it('saves inventory part requests without treating them as issued stock', async () => {
    const fixture = TestBed.createComponent(RepairPage);
    const page = fixture.componentInstance;
    page.selectedPartSku.set('PART-1');
    page.selectedPartQuantity.set(2);
    await page.requestSelectedPart(repair());

    expect(updateRepairWorkshop).toHaveBeenCalledWith(
      'repair-1',
      { partRequest: { sku: 'PART-1', quantity: 2 } },
    );
    expect(page.notice()).toContain('Inventory is not reserved');
  });

  it('assigns the best verified specialization match from the partner workload list', async () => {
    partners.set([{
      id: 'repair-partner-1',
      name: 'Acme Bench',
      type: 'repairing',
      rating: 4.8,
      jobsDone: 12,
      online: true,
      busy: false,
      verified: true,
      city: 'Jaipur',
      specializations: ['Acme VFD'],
    }]);
    const fixture = TestBed.createComponent(RepairPage);
    await fixture.componentInstance.assignRecommendedPartner(repair());

    expect(updateRepairWorkshop).toHaveBeenCalledWith(
      'repair-1',
      { benchPartnerId: 'repair-partner-1' },
    );
  });

  it('bulk assigns selected active tickets to a verified partner', async () => {
    partners.set([{
      id: 'repair-partner-1',
      name: 'Acme Bench',
      type: 'repairing',
      rating: 4.8,
      jobsDone: 12,
      online: true,
      busy: false,
      verified: true,
      city: 'Jaipur',
      specializations: ['Acme VFD'],
    }]);
    const fixture = TestBed.createComponent(RepairPage);
    const page = fixture.componentInstance;
    page.selectedTicketIds.set(['repair-1']);
    page.bulkPartnerId.set('repair-partner-1');
    await page.assignSelectedToPartner();

    expect(assignMany).toHaveBeenCalledWith(['repair-1'], 'repair-partner-1');
    expect(page.selectedTicketIds()).toEqual([]);
    expect(page.notice()).toContain('assigned to Acme Bench');
  });
});
