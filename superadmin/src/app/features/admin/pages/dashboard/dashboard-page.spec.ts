import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { PlatformRegistration } from '../../../../core/models/user.model';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { OperationsService, type Company } from '../../../../core/services/operations.service';
import { DashboardPage } from './dashboard-page';

function registration(
  id: string,
  app: PlatformRegistration['app'],
  rating: number | null,
  experienceYears: string | null,
): PlatformRegistration {
  return {
    id,
    registrationId: id,
    app,
    name: id,
    email: null,
    phone: null,
    role: 'technician',
    status: 'active',
    registeredAt: null,
    profile: {
      businessName: null,
      companyName: null,
      registeredAddress: null,
      serviceAreas: [],
      specializations: [],
      experienceYears,
      qualification: null,
      online: null,
      busy: false,
      completedServices: 0,
      totalServices: 0,
      totalEarnings: null,
      pendingEarnings: null,
      rating,
      ratingCount: null,
      ratings: [],
      latestService: null,
    },
  };
}

describe('DashboardPage', () => {
  let fixture: ComponentFixture<DashboardPage>;
  let page: DashboardPage;
  const auth = { canAccess: vi.fn((_page: string) => false) };
  const api = {
    getRegistrations: vi.fn(),
    getUsers: vi.fn(),
    getOperations: vi.fn(),
  };

  beforeEach(async () => {
    auth.canAccess.mockReset().mockReturnValue(false);
    api.getOperations.mockReset();
    await TestBed.configureTestingModule({
      imports: [DashboardPage],
      providers: [
        { provide: AdminApiService, useValue: api },
        { provide: AuthService, useValue: auth },
        provideRouter([]),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(DashboardPage);
    page = fixture.componentInstance;
  });

  it('ranks every Energy Hub provider and keeps unrated providers below rated ones', () => {
    page.registrations.set([
      registration('rated-low', 'energy-hub', 3.5, '2 years'),
      registration('unrated', 'energy-hub', null, '10 years'),
      registration('rated-high', 'energy-hub', 4.8, '1 year'),
      registration('service-user', 'service-admin', 5, '20 years'),
      registration('rated-mid', 'energy-hub', 4.2, '3 years'),
      registration('rated-other', 'energy-hub', 4, '4 years'),
      registration('rated-last', 'energy-hub', 3, '1 year'),
    ]);

    expect(page.providerPerformance().map((provider) => provider.id)).toEqual([
      'rated-high',
      'rated-mid',
      'rated-other',
      'rated-low',
      'rated-last',
      'unrated',
    ]);
  });

  it('hides test accounts by default and flags 60-day inactivity and over-50% concentration', async () => {
    const oldActivity = new Date(Date.now() - 61 * 24 * 60 * 60_000).toISOString();
    const recentActivity = new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString();
    const companies: Company[] = [
      { id: '1', name: 'Acme', gst: '', sites: 1, users: 2, amc: 'Active', totalJobs: 4, revenue: 60, lastActivityAt: oldActivity },
      { id: '2', name: 'Beta', gst: '', sites: 1, users: 1, amc: 'Active', totalJobs: 2, revenue: 40, lastActivityAt: recentActivity },
      { id: '3', name: 'Sandbox Demo', gst: '', sites: 0, users: 0, amc: 'None', totalJobs: 0, revenue: 1000, lastActivityAt: null },
    ];
    auth.canAccess.mockImplementation((pageKey) => pageKey === 'companies');
    api.getOperations.mockImplementation(async (domain: string) => ({
      items: domain === 'companies' ? companies : [],
      sourceStatus: 'connected',
    }));

    TestBed.inject(OperationsService).loadAuthorizedData();
    await vi.waitFor(() => expect(page.portfolioCompanies().length).toBe(2));

    expect(page.portfolioCompanies().map((company) => company.name)).toEqual(['Acme', 'Beta']);
    expect(page.customerSummary().churnRisk).toBe(1);
    expect(page.smartInsights().some((insight) => insight.title.includes('60%'))).toBe(true);

    const showTestAccounts = document.createElement('input');
    showTestAccounts.type = 'checkbox';
    showTestAccounts.checked = true;
    page.setShowTestAccounts({ target: showTestAccounts } as unknown as Event);
    expect(page.portfolioCompanies()).toHaveLength(3);
  });
});
