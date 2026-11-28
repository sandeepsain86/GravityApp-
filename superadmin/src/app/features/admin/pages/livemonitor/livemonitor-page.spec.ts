import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { OperationsService, type Job, type Partner, type RepairTicket } from '../../../../core/services/operations.service';
import type { PlatformRegistrationDetails } from '../../../../core/models/user.model';
import { LivemonitorPage } from './livemonitor-page';

function job(id: string, status: Job['status'], slaMinsLeft: number | null): Job {
  return {
    id,
    company: 'Test Company',
    service: 'Service job',
    partner: status === 'progress' ? 'Assigned Partner' : null,
    status,
    slaMinsLeft,
    amount: 1000,
    site: 'Test Site',
    jobType: 'service',
    targetRole: 'service_partner',
  };
}

function partner(id: string, type: Partner['type']): Partner {
  return {
    id,
    name: id,
    type,
    rating: 4.5,
    jobsDone: 3,
    experienceYears: '5 years',
    online: true,
    verified: true,
    city: 'Test City',
  };
}

function trackingProfile(): PlatformRegistrationDetails {
  return {
    registration: {
      id: 'energy-hub:21',
      registrationId: 'EH-PARTNER-21',
      app: 'energy-hub',
      name: 'Partner 21',
      email: null,
      phone: null,
      role: 'service_partner',
      status: 'approved',
      registeredAt: null,
      profile: {
        businessName: null,
        companyName: null,
        registeredAddress: null,
        serviceAreas: ['Jaipur'],
        specializations: ['Electrical'],
        experienceYears: '5 years',
        qualification: null,
        online: true,
        busy: true,
        completedServices: 5,
        totalServices: 6,
        totalEarnings: 12_000,
        pendingEarnings: 2_000,
        rating: 4.7,
        ratingCount: null,
        ratings: [],
        latestService: null,
      },
    },
    account: {
      avatarUrl: null,
      secondaryPhone: null,
      emailVerified: null,
      phoneVerified: null,
      lastLoginAt: null,
      updatedAt: null,
      currentWork: {
        id: '21',
        reference: 'JOB-21',
        title: 'Inverter repair',
        stage: 'checked_in',
        site: 'Plant 1, Jaipur',
        startedAt: '2026-11-26T08:00:00.000Z',
        checkedInAt: '2026-11-26T09:30:00.000Z',
        lastLocationUpdateAt: '2026-11-26T11:59:00.000Z',
        liveLocation: { latitude: 26.9124, longitude: 75.7873 },
        distanceKm: 8.5,
        travelEtaMinutes: 24,
      },
      partnerSince: null,
      travelRadiusKm: null,
      onboarding: null,
      payoutProfileConfigured: null,
      vehicleVerification: null,
      companies: [],
      sites: [],
      devices: [],
      documents: [],
    },
    activity: [{
      id: '21',
      kind: 'job',
      reference: 'JOB-21',
      title: 'Inverter repair',
      status: 'in_progress',
      priority: null,
      description: null,
      location: 'Plant 1, Jaipur',
      createdAt: '2026-11-26T08:00:00.000Z',
      scheduledAt: null,
      completedAt: null,
      dueAt: null,
      assignedTo: null,
      amount: null,
      currency: 'INR',
      details: [],
      timeline: [{ label: 'Check-in', status: 'done', note: null, at: '2026-11-26T09:30:00.000Z' }],
    }],
    statusBreakdown: [],
    monthlyActivity: [],
    financialSummary: {
      kind: 'payouts',
      total: 12_000,
      paid: 10_000,
      pending: 2_000,
      failed: 0,
      commission: 0,
      deductions: 0,
      count: 6,
    },
    earnings: [],
    orders: [],
    supportRequests: [],
  };
}

describe('LivemonitorPage', () => {
  let fixture: ComponentFixture<LivemonitorPage>;
  let page: LivemonitorPage;
  let operations: OperationsService;
  const canAccess = vi.fn((_pageKey: string) => true);
  const api = {
    getOperations: vi.fn(),
    assignOperationJob: vi.fn(),
    getRegistrationDetails: vi.fn(),
    openTrackingProfile: vi.fn(),
    errorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
  };

  beforeEach(async () => {
    canAccess.mockReturnValue(true);
    vi.clearAllMocks();
    await TestBed.configureTestingModule({
      imports: [LivemonitorPage],
      providers: [
        { provide: AdminApiService, useValue: api },
        { provide: AuthService, useValue: { canAccess } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(LivemonitorPage);
    page = fixture.componentInstance;
    operations = TestBed.inject(OperationsService);
    api.getOperations.mockImplementation(async () => ({
      jobs: operations.jobs(),
      partners: operations.partners(),
      sourceStatus: 'connected',
    }));
    api.assignOperationJob.mockResolvedValue({
      changed: true,
      jobId: '41',
      reference: 'DEMO-SVC-overdue',
      partnerId: 'service-1',
      partnerName: 'service-1',
      assignedAt: new Date().toISOString(),
    });
  });

  it('uses the same disjoint open, unassigned, in-progress and breached job counts', () => {
    operations.jobs.set([
      job('unassigned', 'unassigned', 90),
      job('progress', 'progress', 120),
      job('at-risk', 'progress', 45),
      { ...job('breached', 'sla-risk', -75), partner: 'Assigned Partner', partnerId: 'partner-2' },
      job('complete', 'completed', null),
    ]);

    expect(page.jobCount('all')).toBe(4);
    expect(page.jobCount('unassigned')).toBe(1);
    expect(page.jobCount('progress')).toBe(2);
    expect(page.jobCount('at-risk')).toBe(1);
    expect(page.jobCount('breached')).toBe(1);
  });

  it('formats overdue SLA durations as days and hours', () => {
    expect(page.formatSla(-39_683)).toBe('27d 13h overdue');
    expect(page.formatSla(45)).toBe('45m left');
    expect(page.formatSla(null)).toBe('SLA not set');
  });

  it('omits the received-stage count when it duplicates the active-repairs total', () => {
    operations.repairs.set([{ stage: 'received' } as RepairTicket]);

    expect(page.repairStageBreakdown()).toEqual([]);
  });

  it('escalates unassigned work after 15 minutes and updates SLA countdown from due time', () => {
    const now = Date.parse('2026-11-26T12:00:00.000Z');
    page.clockNow.set(now);
    operations.jobs.set([
      {
        ...job('JOB-ESCALATED', 'unassigned', 30),
        createdAt: new Date(now - 16 * 60_000).toISOString(),
        slaDueAt: new Date(now + 5 * 60_000).toISOString(),
      },
      {
        ...job('JOB-RECENT', 'unassigned', 30),
        createdAt: new Date(now - 10 * 60_000).toISOString(),
      },
    ]);

    expect(page.escalatedUnassignedJobs().map((entry) => entry.id)).toEqual(['JOB-ESCALATED']);
    expect(page.filteredJobs()[0].slaMinsLeft).toBe(5);

    page.clockNow.set(now + 6 * 60_000);
    expect(page.filteredJobs().find((entry) => entry.id === 'JOB-ESCALATED')?.status).toBe('sla-risk');
    expect(page.filteredJobs().find((entry) => entry.id === 'JOB-ESCALATED')?.slaMinsLeft).toBe(-1);
  });

  it('does not present GPS older than 90 minutes as live', () => {
    const now = Date.parse('2026-11-26T12:00:00.000Z');
    page.clockNow.set(now);
    const updatedAt = new Date(now - 91 * 60_000).toISOString();
    const staleJob = {
      ...job('JOB-STALE-GPS', 'progress', 30),
      liveLocation: { latitude: 28.6139, longitude: 77.209, updatedAt },
      lastLocationAt: updatedAt,
    };

    expect(page.currentLocation(staleJob)).toBeNull();
    expect(page.locationLabel(staleJob)).toContain('GPS stale');
  });

  it('only offers online partners matched to the job role prefix', () => {
    operations.partners.set([
      partner('Supplier One', 'supplier'),
      partner('Repair Team', 'repairing'),
      partner('Service Team', 'service'),
    ]);

    expect(page.matchingPartners({
      ...job('DEMO-DEL-2026-OPEN-10', 'unassigned', 30),
      targetRole: 'delivery_partner',
    })
      .map((entry) => entry.name)).toEqual(['Supplier One']);
    expect(page.matchingPartners({
      ...job('DEMO-REP-2026-OPEN-10', 'unassigned', 30),
      targetRole: 'repairing_partner',
    })
      .map((entry) => entry.name)).toEqual(['Repair Team']);
  });

  it('ranks approved specialization matches ahead of otherwise equal role matches', () => {
    operations.partners.set([
      partner('general', 'service'),
      { ...partner('vfd-specialist', 'service'), specializations: ['VFD repair'] },
    ]);

    expect(page.matchingPartners({
      ...job('JOB-SKILL-MATCH', 'unassigned', 30),
      service: 'VFD repair',
      issue: 'Drive overload',
      targetRole: 'service_partner',
    }).map((entry) => entry.id)).toEqual(['vfd-specialist', 'general']);
  });

  it('filters live jobs by search, type and priority, then paginates at 20 rows', () => {
    operations.jobs.set(Array.from({ length: 25 }, (_, index) => ({
      ...job(`JOB-${index + 1}`, 'unassigned', 90),
      company: `Customer ${index + 1}`,
      jobType: index % 2 ? 'repair' : 'service',
      priority: index === 24 ? 'high' : 'normal',
    })));

    expect(page.jobs()).toHaveLength(20);
    expect(page.jobPageCount()).toBe(2);
    page.nextJobPage();
    expect(page.jobs()).toHaveLength(5);

    page.setJobType({ target: { value: 'repair' } } as unknown as Event);
    expect(page.currentJobPage()).toBe(1);
    expect(page.filteredJobs()).toHaveLength(12);

    page.setJobType({ target: { value: 'all' } } as unknown as Event);
    page.setHighPriority({ target: { checked: true } } as unknown as Event);
    expect(page.filteredJobs().map((entry) => entry.id)).toEqual(['JOB-25']);
  });

  it('does not recommend offline, unverified or busy partners', () => {
    operations.partners.set([
      partner('available', 'service'),
      { ...partner('busy', 'service'), busy: true },
      { ...partner('offline', 'service'), online: false },
      { ...partner('unverified', 'service'), verified: false },
    ]);

    expect(page.matchingPartners(job('SVC-OPEN-1', 'unassigned', 30))
      .map((entry) => entry.id)).toEqual(['available']);
  });

  it('persists assignments by partner ID and keeps breached status after dispatch', async () => {
    const overdue = { ...job('DEMO-SVC-overdue', 'sla-risk', -15) };
    operations.jobs.set([overdue]);
    operations.partners.set([partner('service-1', 'service')]);

    await page.assignBestPartner(overdue);

    expect(api.assignOperationJob).toHaveBeenCalledWith('DEMO-SVC-overdue', 'service-1');
    expect(operations.jobs()[0].status).toBe('sla-risk');
    expect(operations.jobs()[0].partnerId).toBe('service-1');
    expect(page.assignmentMessage()).toContain('assigned and queue refreshed');
  });

  it('refreshes job data on demand and records the last successful sync time', async () => {
    page.toggleAutoRefresh();
    expect(page.autoRefresh()).toBe(false);

    await page.refreshLiveJobs();

    expect(api.getOperations).toHaveBeenCalledWith('jobs');
    expect(operations.jobsLastSyncedAt()).not.toBeNull();
  });

  it('opens and closes the accessible job detail drawer', () => {
    operations.jobs.set([{ ...job('JOB-DETAIL', 'unassigned', 45), issue: 'Output phase fault' }]);
    page.openJobDetails('JOB-DETAIL');
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.textContent).toContain('Output phase fault');
    fixture.nativeElement.querySelector('.job-detail-header button').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
  });

  it('audits tracking-profile opens and exposes an accessible closable dialog', async () => {
    api.openTrackingProfile.mockResolvedValue(trackingProfile());
    page.openPartnerProfile(partner('21', 'service'));

    expect(api.openTrackingProfile).toHaveBeenCalledWith('energy-hub:21');
    await vi.waitFor(() => expect(page.trackingDetails()?.registration.registrationId).toBe('EH-PARTNER-21'));
    page.clockNow.set(Date.parse('2026-11-26T12:00:00.000Z'));
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.textContent).toContain('26.91240, 75.78730');
    expect(dialog?.textContent).toContain('2h 30m');
    expect(dialog?.textContent).toContain('8.5 km');
    expect(dialog?.textContent).toContain('Check-in · done');
    expect(dialog?.querySelector('.tracking-map-link')?.getAttribute('href'))
      .toContain('26.9124,75.7873');
    fixture.nativeElement.querySelector('.live-profile-close').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
  });

  it('surfaces tracking profile errors instead of showing an empty success state', async () => {
    api.openTrackingProfile.mockRejectedValue(new Error('network unavailable'));
    page.openPartnerProfile(partner('21', 'service'));

    await vi.waitFor(() => expect(page.trackingError()).toBe('Partner tracking details could not be loaded.'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent)
      .toContain('Partner tracking details could not be loaded.');
  });

  it('does not open a tracking profile without directory permission', () => {
    canAccess.mockImplementation((pageKey: string) => pageKey !== 'directory');
    page.openPartnerProfile(partner('21', 'service'));

    expect(api.openTrackingProfile).not.toHaveBeenCalled();
    expect(page.trackedPartner()).toBeNull();
  });

  it('reports checked-in elapsed time without claiming a live travel ETA', () => {
    page.clockNow.set(Date.parse('2026-11-26T12:00:00.000Z'));

    expect(page.elapsedSince('2026-11-26T09:30:00.000Z')).toBe('2h 30m');
    expect(page.elapsedSince('2026-11-26T13:00:00.000Z')).toBe('Not available');
  });
});
