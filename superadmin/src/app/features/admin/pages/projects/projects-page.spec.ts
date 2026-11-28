import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { OperationsService, type ProjectRequest } from '../../../../core/services/operations.service';
import { ProjectsPage } from './projects-page';

function project(overrides: Partial<ProjectRequest> = {}): ProjectRequest {
  return {
    id: 'PRJ-1',
    requestId: 'project-1',
    company: 'Example Industries',
    title: 'Control panel upgrade',
    panels: 'Two panels',
    status: 'in_progress',
    eta: 'Q4 2026',
    value: 1_200_000,
    currency: 'INR',
    site: 'Main plant',
    category: 'Automation',
    projectType: 'PLC',
    description: 'Replace legacy controls',
    requirements: 'PLC integration',
    createdAt: '2026-01-01T00:00:00.000Z',
    submittedAt: '2026-01-02T00:00:00.000Z',
    completedAt: null,
    details: {},
    milestones: [{
      id: 'milestone-1',
      title: 'Install equipment',
      sequence: 1,
      status: 'in_progress',
      plannedStart: '2026-01-10',
      dueDate: '2026-01-20',
      completedAt: null,
      clientSignoffStatus: 'pending',
      leadEngineerName: 'Engineer A',
      budgetAmount: 400_000,
      materialCost: 50_000,
      partnerPayout: 20_000,
      billedAmount: 100_000,
    }],
    statusHistory: [],
    ...overrides,
  };
}

describe('ProjectsPage', () => {
  let projects: ReturnType<typeof signal<ProjectRequest[]>>;
  let loadProjects: ReturnType<typeof vi.fn>;
  let transitionProjectStatus: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    projects = signal([project(), project({
      id: 'PRJ-2',
      requestId: 'project-2',
      status: 'submitted',
      value: null,
      milestones: [],
    })]);
    loadProjects = vi.fn().mockResolvedValue(true);
    transitionProjectStatus = vi.fn().mockResolvedValue({});
    await TestBed.configureTestingModule({
      imports: [ProjectsPage],
      providers: [
        {
          provide: OperationsService,
          useValue: { projects, loadErrors: signal({}), loadProjects },
        },
        { provide: AuthService, useValue: { canAccess: () => true } },
        {
          provide: AdminApiService,
          useValue: {
            transitionProjectStatus,
            createProjectMilestone: vi.fn().mockResolvedValue(undefined),
            updateProjectMilestone: vi.fn().mockResolvedValue(undefined),
            errorMessage: (_error: unknown, fallback: string) => fallback,
          },
        },
      ],
    }).compileComponents();
  });

  it('filters the portfolio by risk and by selected lifecycle chart stage', () => {
    const page = TestBed.createComponent(ProjectsPage).componentInstance;
    expect(page.filteredProjects()).toHaveLength(2);

    page.setQueueFilter('signoff');
    expect(page.filteredProjects().map((item) => item.id)).toEqual(['PRJ-1']);

    page.setQueueFilter('all');
    page.onChartSelect('status', {
      label: 'Submitted',
      datasetLabel: 'Projects',
      dataIndex: 1,
      datasetIndex: 0,
    });
    expect(page.filteredProjects().map((item) => item.id)).toEqual(['PRJ-2']);

    page.chartFilter.set(null);
    projects.update((items) => items.map((item) => item.id === 'PRJ-1'
      ? { ...item, milestones: [{ ...item.milestones[0], dueDate: '2000-01-01' }] }
      : item));
    page.setQueueFilter('at-risk');
    expect(page.filteredProjects().map((item) => item.id)).toEqual(['PRJ-1']);
  });

  it('calculates margin only from milestones with both billing and recorded costs', () => {
    const page = TestBed.createComponent(ProjectsPage).componentInstance;
    const margin = page.executiveKpis().find((metric) => metric.key === 'margin');
    expect(margin?.value).toBe('30%');
  });

  it('posts the selected legal status transition and refreshes the project data', async () => {
    const page = TestBed.createComponent(ProjectsPage).componentInstance;
    await page.changeStatus(project(), 'completed');
    expect(transitionProjectStatus).toHaveBeenCalledWith('project-1', 'completed');
    expect(loadProjects).toHaveBeenCalledOnce();
    expect(page.notice()).toContain('Completed');
  });
});
