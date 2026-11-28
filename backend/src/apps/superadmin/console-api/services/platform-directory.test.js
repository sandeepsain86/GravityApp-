const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlatformDirectory } = require('./platform-directory');

test('platform directory returns private-safe profiles with stable app registration IDs', async () => {
  const providerDb = {
    async query(sql) {
      if (sql.includes('FROM users')) {
        return [
          {
            id: 12,
            mobile: '9000000000',
            email: 'partner@example.test',
            role: 'service_partner',
            status: 'approved',
            full_name: 'Asha Sharma',
            business_name: 'Asha Electricals',
            address: 'Jaipur',
            years_experience: '8',
            qualification: 'ITI',
            service_areas: 'Jaipur, Ajmer',
            rating: '4.8',
            jobs_completed: 5,
            is_online: true,
            is_busy: true,
            created_at: '2026-01-02T00:00:00.000Z',
          },
          {
            id: 13,
            role: 'repairing_partner',
            status: 'pending',
            full_name: 'Another Partner',
            reference_id: 'EN-PARTNER-10003',
            jobs_completed: 0,
          },
        ];
      }
      if (sql.includes('FROM partner_applications')) {
        return [{
          id: 3,
          user_id: 12,
          partner_role: 'service_partner',
          reference_id: 'EN-PARTNER-10003',
          service_areas: 'Jaipur, Ajmer',
        }];
      }
      if (sql.includes('FROM jobs')) {
        if (sql.includes('COUNT(*)')) {
          return [{ assigned_partner_id: 12, total_services: 6 }];
        }
        return [{
          id: 9,
          reference_id: 'JOB-9',
          assigned_partner_id: 12,
          title: 'Panel repair',
          status: 'in_progress',
          stage: 'diagnosed',
          site_address: 'Plant 4, Jaipur',
          sla_due_at: '2026-11-20T14:00:00.000Z',
          estimated_drive_minutes: 25,
        }];
      }
      if (sql.includes('FROM earnings')) return [{ partner_id: 12, status: 'pending', net_amount: '3200' }];
      throw new Error('Unexpected provider query');
    },
  };
  const servicePool = {
    async query(sql) {
      if (sql.includes('FROM public.field_jobs')) return { rows: [] };
      if (sql.includes('FROM public.users')) {
        return {
          rows: [{
            id: 'user-abc',
            full_name: 'Rohan Mehta',
            role: 'owner',
            status: 'active',
            company_name: 'Mehta Industries',
            total_services: 2,
            completed_services: 1,
            latest_service_id: 'SR-8',
            latest_service_title: 'Motor repair',
            latest_service_status: 'in_progress',
            latest_service_location: 'Plant 1, Jaipur',
          }],
        };
      }
      throw new Error('Unexpected service query');
    },
  };
  const directory = createPlatformDirectory({ providerDb, servicePool });

  const registrations = await directory.listRegistrations();
  const partner = registrations.find((entry) => entry.app === 'energy-hub');
  const customer = registrations.find((entry) => entry.app === 'service-admin');

  assert.equal(registrations.length, 3);
  assert.equal(partner.registrationId, 'EN-PARTNER-10003-U12');
  assert.equal(partner.profile.latestService.location, 'Plant 4, Jaipur');
  assert.equal(partner.profile.pendingEarnings, 3200);
  assert.equal(partner.profile.rating, 4.8);
  assert.equal(partner.profile.totalServices, 6);
  assert.equal(partner.profile.ratingCount, null);
  assert.equal(customer.registrationId, 'SA-CUSTOMER-user-abc');
  assert.equal(customer.profile.totalServices, 2);
  assert.equal(customer.profile.latestService.title, 'Motor repair');
  assert.equal(new Set(registrations.map((entry) => entry.registrationId)).size, registrations.length);
  assert.equal('password_hash' in customer, false);
  assert.equal('bank_account_number' in partner, false);
});

test('partner profile includes job stages, documents and payout breakdown without bank identifiers', async () => {
  let locationUpdatedAt = new Date().toISOString();
  let liveLatitude = 18.5204;
  let liveLongitude = 73.8567;
  const providerDb = {
    async query(sql) {
      if (sql.includes('FROM users')) {
        return [{
          id: 21,
          full_name: 'Partner Profile',
          role: 'service_partner',
          status: 'approved',
          mobile: '9000000000',
          rating: 4.7,
          jobs_completed: 1,
          bank_account_holder: 'Partner Profile',
          bank_name: 'Example Bank',
          bank_account_number: 'never-return-this',
          created_at: '2026-01-01T00:00:00.000Z',
        }];
      }
      if (sql.includes('FROM partner_applications')) {
        return [{
          user_id: 21,
          partner_role: 'service_partner',
          status: 'approved',
          current_step: 5,
          submitted_at: '2026-01-01T00:00:00.000Z',
        }];
      }
      if (sql.includes('FROM jobs')) {
        return [
          {
            id: 102,
            reference_id: 'JOB-102',
            job_type: 'service',
            title: 'Newly accepted service',
            status: 'accepted',
            stage: 'accepted',
            created_at: '2026-03-01T00:00:00.000Z',
          },
          {
            id: 101,
            reference_id: 'JOB-101',
            job_type: 'service',
            title: 'Inverter service',
            status: 'in_progress',
            category: 'Electrical',
            equipment: 'Inverter',
            stage: 'checked_in',
            created_at: '2026-02-01T00:00:00.000Z',
            completed_at: '2026-02-02T00:00:00.000Z',
            total_bill: 2500,
            payout_amount: 1800,
            distance_km: 8.5,
            estimated_drive_minutes: 24,
          },
        ];
      }
      if (sql.includes('FROM earnings')) {
        return [{
          id: 7,
          job_id: 101,
          source: 'service',
          gross_amount: 2500,
          commission: 500,
          deductions: 200,
          net_amount: 1800,
          status: 'pending',
          created_at: '2026-02-02T00:00:00.000Z',
        }];
      }
      if (sql.includes('FROM partner_documents')) {
        return [{ doc_type: 'business_registration', status: 'verified', created_at: '2026-01-03T00:00:00.000Z', file_ref: 'private-file-ref' }];
      }
      if (sql.includes('FROM delivery_verifications')) return [];
      if (sql.includes('FROM job_stage_history')) {
        return [{ job_id: 101, from_stage: 'accepted', to_stage: 'completed', at: '2026-02-02T00:00:00.000Z' }];
      }
      if (sql.includes('FROM job_workflow_steps')) {
        return [
          {
            job_id: 101,
            step_key: 'checkin',
            status: 'done',
            checked_in_at: '2026-02-01T01:00:00.000Z',
            completed_at: '2026-02-01T01:00:00.000Z',
            at: '2026-02-01T01:00:00.000Z',
          },
          { job_id: 101, step_key: 'diagnosis', status: 'completed', at: '2026-02-02T00:00:00.000Z' },
        ];
      }
      if (sql.includes('FROM job_live_locations')) {
        return [{
          job_id: 101,
          latitude: liveLatitude,
          longitude: liveLongitude,
          updated_at: locationUpdatedAt,
        }];
      }
      throw new Error('Unexpected provider detail query');
    },
  };
  const directory = createPlatformDirectory({ providerDb, servicePool: { query: async () => ({ rows: [] }) } });

  const details = await directory.getRegistrationDetails('energy-hub:21');

  assert.equal(details.registration.registrationId, 'EH-PARTNER-21');
  assert.equal(details.activity.find((item) => item.reference === 'JOB-101').timeline.length, 3);
  assert.equal(details.account.onboarding.currentStep, 5);
  assert.equal(details.account.documents[0].status, 'verified');
  assert.equal(details.account.currentWork.reference, 'JOB-101');
  assert.equal(details.account.currentWork.startedAt, '2026-02-01T00:00:00.000Z');
  assert.equal(details.account.currentWork.checkedInAt, '2026-02-01T01:00:00.000Z');
  assert.equal(details.account.currentWork.distanceKm, 8.5);
  assert.equal(details.account.currentWork.travelEtaMinutes, 24);
  assert.deepEqual(details.account.currentWork.liveLocation, { latitude: 18.5204, longitude: 73.8567 });
  assert.equal(details.financialSummary.pending, 1800);
  assert.equal(details.earnings[0].commission, 500);
  assert.equal(JSON.stringify(details).includes('never-return-this'), false);
  assert.equal(JSON.stringify(details).includes('private-file-ref'), false);

  locationUpdatedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const staleDetails = await directory.getRegistrationDetails('energy-hub:21');
  assert.equal(staleDetails.account.currentWork.liveLocation, null);
  assert.ok(staleDetails.account.currentWork.lastLocationUpdateAt);
  locationUpdatedAt = new Date().toISOString();
  liveLatitude = 91;
  const invalidLocationDetails = await directory.getRegistrationDetails('energy-hub:21');
  assert.equal(invalidLocationDetails.account.currentWork.liveLocation, null);
});

test('customer profile includes service, repair, company, site and marketplace history', async () => {
  const servicePool = {
    async query(sql) {
      if (sql.includes('WITH service_totals AS')) {
        return { rows: [{
          id: 'customer-1',
          full_name: 'Customer Profile',
          email: 'customer@example.test',
          phone: '9000000001',
          secondary_phone: '9000000002',
          email_verified: true,
          phone_verified: false,
          status: 'active',
          role: 'owner',
          company_name: 'Customer Company',
          company_city: 'Jaipur',
          total_services: 1,
          completed_services: 1,
          created_at: '2026-01-01T00:00:00.000Z',
          password_hash: 'must-not-be-returned',
        }] };
      }
      if (sql.includes('FROM public.companies company')) return { rows: [{ company_name: 'Customer Company', industry: 'Energy', city: 'Jaipur', status: 'active' }] };
      if (sql.includes('FROM public.sites site')) return { rows: [{ site_name: 'Main site', address: 'Business Road', city: 'Jaipur', is_primary: true, device_count: 2 }] };
      if (sql.includes('FROM public.devices device')) return { rows: [{ device_type: 'Inverter', manufacturer: 'Example', model: 'X1', site_name: 'Main site' }] };
      if (sql.includes('SELECT request.id, request.request_number, category.name')) return { rows: [{
        id: 'service-1', request_number: 'SR-1', category_name: 'Installation', status: 'completed',
        priority: 'normal', preferred_date: '2026-02-02', preferred_time: '10:00',
        submitted_at: '2026-02-01T00:00:00.000Z', completed_at: '2026-02-02T00:00:00.000Z',
        location: 'Main site, Business Road, Jaipur',
      }] };
      if (sql.includes('FROM public.service_request_selections')) return { rows: [{ request_id: 'service-1', step_title: 'Equipment', option_name: 'Inverter' }] };
      if (sql.includes('FROM public.service_request_status_history')) return { rows: [{ item_id: 'service-1', status: 'completed', at: '2026-02-02T00:00:00.000Z' }] };
      if (sql.includes('FROM public.repair_tickets ticket')) return { rows: [{
        id: 'repair-1', ticket_number: 'REP-1', service_type: 'Repair', status: 'open',
        created_at: '2026-02-03T00:00:00.000Z', issue_description: 'Unit is not powering on',
      }] };
      if (sql.includes('FROM public.repair_status_history')) return { rows: [] };
      if (sql.includes('FROM public.project_requests request')) return { rows: [] };
      if (sql.includes('FROM public.project_status_history')) return { rows: [] };
      if (sql.includes('FROM public.amc_contracts contract')) return { rows: [] };
      if (sql.includes('FROM public.amc_status_history')) return { rows: [] };
      if (sql.includes('FROM public.orders order_row')) return { rows: [{
        id: 'order-1', order_number: 'ORD-1', status: 'complete', currency: 'INR',
        subtotal: 1000, delivery_fee: 50, total: 1050, payment_mode: 'UPI',
        payment_status: 'paid', payment_provider: 'ExamplePay', payment_amount: 1050,
        created_at: '2026-02-04T00:00:00.000Z',
      }] };
      if (sql.includes('FROM public.order_status_history')) return { rows: [{ item_id: 'order-1', status: 'complete', at: '2026-02-04T00:00:00.000Z' }] };
      if (sql.includes('FROM public.support_requests')) return { rows: [{ subject: 'Service follow-up', status: 'open', created_at: '2026-02-05T00:00:00.000Z' }] };
      throw new Error(`Unexpected customer detail query: ${sql}`);
    },
  };
  const directory = createPlatformDirectory({ providerDb: { query: async () => [] }, servicePool });

  const details = await directory.getRegistrationDetails('service-admin:customer-1');

  assert.equal(details.registration.registrationId, 'SA-CUSTOMER-customer-1');
  assert.equal(details.activity.length, 2, JSON.stringify(details.activity.map((item) => item.kind)));
  assert.equal(details.activity.find((item) => item.kind === 'service').details[0], 'Equipment: Inverter');
  assert.equal(details.account.sites[0].deviceCount, 2);
  assert.equal(details.account.devices[0].model, 'X1');
  assert.equal(details.orders[0].paymentAmount, 1050);
  assert.equal(details.financialSummary.paid, 1050);
  assert.equal(details.supportRequests[0].subject, 'Service follow-up');
  assert.equal(JSON.stringify(details).includes('must-not-be-returned'), false);
});
