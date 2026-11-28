import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { OperationsService } from '../../../../core/services/operations.service';
import { JobsPage } from './jobs-page';

describe('JobsPage', () => {
  let fixture: ComponentFixture<JobsPage>;
  let page: JobsPage;
  let operations: OperationsService;
  const canAccess = vi.fn(() => true);
  const api = {
    getOperations: vi.fn(),
    assignOperationJob: vi.fn(),
    errorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
  };

  beforeEach(async () => {
    canAccess.mockReturnValue(true);
    api.getOperations.mockReset();
    api.assignOperationJob.mockReset().mockResolvedValue({
      changed: true,
      jobId: '41',
      reference: 'EC-IND-0140',
      partnerId: 'test-partner',
      partnerName: 'Suresh Kumar',
      assignedAt: new Date().toISOString(),
    });
    await TestBed.configureTestingModule({
      imports: [JobsPage],
      providers: [
        { provide: AdminApiService, useValue: api },
        { provide: AuthService, useValue: { canAccess } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(JobsPage);
    page = fixture.componentInstance;
    operations = TestBed.inject(OperationsService);
    operations.jobs.set([{
      id: 'EC-IND-0140',
      company: 'Test Company',
      service: 'VFD Repair',
      partner: null,
      status: 'unassigned',
      slaMinsLeft: 30,
      amount: 4200,
      site: 'Test Site',
      asset: 'Delta VFD',
      createdAt: new Date().toISOString(),
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      rawStage: 'diagnosed',
      totalBill: 4200,
      payoutAmount: 3000,
      partsTotal: 400,
      beforePhotoCount: 1,
      afterPhotoCount: 0,
      stageHistory: [{
        at: new Date().toISOString(),
        fromStage: 'accepted',
        toStage: 'diagnosed',
        note: 'Diagnosis saved',
      }],
      activity: [],
    }]);
    operations.partners.set([{
      id: 'test-partner',
      name: 'Suresh Kumar',
      type: 'service',
      rating: 0,
      jobsDone: 0,
      online: false,
      verified: true,
      city: 'Test City',
    }]);
    api.getOperations.mockImplementation(async () => ({
      jobs: operations.jobs(),
      partners: operations.partners(),
      sourceStatus: 'connected',
    }));
    fixture.detectChanges();
  });

  it('renders the operational queue and open-job summaries', () => {
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelectorAll('.job-card')).toHaveLength(1);
    expect(element.querySelector('.jobs-header.directory-hero')).not.toBeNull();
    expect(element.querySelectorAll('.job-card-strip')).toHaveLength(1);
    expect(element.querySelectorAll('.job-card-body')).toHaveLength(1);
    expect(element.querySelector('.job-metrics')?.textContent).toContain('Open jobs');
    expect(element.querySelector('.job-metrics')?.textContent).toContain('Needs attention');
    expect(element.textContent).toContain('Dispatch assignments save to the database');
  });

  it('opens job details from the card surface', () => {
    const element = fixture.nativeElement as HTMLElement;
    const card = element.querySelector<HTMLElement>('.job-card');

    expect(card).not.toBeNull();
    card!.querySelector<HTMLElement>('.job-issue')!.click();
    fixture.detectChanges();

    expect(element.querySelector('.job-drawer')).not.toBeNull();
  });

  it('filters unassigned jobs and searches detailed job fields', () => {
    page.setFilter('unassigned');
    fixture.detectChanges();

    expect(page.filteredJobs().map((job) => job.id)).toEqual(['EC-IND-0140']);
    expect(page.count('unassigned')).toBe(1);

    page.setFilter('all');
    page.setSearch({ target: { value: 'Delta VFD' } } as unknown as Event);

    expect(page.filteredJobs().map((job) => job.id)).toEqual(['EC-IND-0140']);
  });

  it('records persisted assignment without locally completing the job', async () => {
    const jobId = 'EC-IND-0140';
    page.openDetails(jobId);
    const select = document.createElement('select');
    const option = document.createElement('option');
    option.value = 'test-partner';
    select.add(option);
    select.value = 'test-partner';
    await page.assign(jobId, { target: select } as unknown as Event);

    expect(page.selectedJob()?.partner).toBe('Suresh Kumar');
    expect(api.assignOperationJob).toHaveBeenCalledWith(jobId, 'test-partner');
    expect(page.selectedJob()?.activity?.at(-1)?.title).toBe('Partner assigned');
    expect(operations.jobs().find((job) => job.id === jobId)?.status).toBe('progress');
    expect(fixture.nativeElement.textContent).not.toContain('Mark job complete');
  });

  it('shows persisted workflow, proof and recorded contribution without session-only controls', () => {
    const jobId = 'EC-IND-0140';
    page.openDetails(jobId);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.textContent).toContain('Diagnosed');
    expect(element.textContent).toContain('Stage history');
    expect(element.textContent).toContain('Before photos');
    expect(element.textContent).toContain('Bill - payout - parts');
    expect(element.textContent).toContain('Not linked to a registered device record');
    expect(element.textContent).not.toContain('Save schedule');
    expect(element.textContent).not.toContain('Advance to');
    expect(element.textContent).not.toContain('Save work note');
    expect(element.querySelector('.session-only-label')).toBeNull();
  });
});
