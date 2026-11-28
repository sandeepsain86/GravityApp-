/**
 * Smoke test - part 2: delivery, earnings, dashboard and PII masking.
 */

const {
  db,
  check,
  expectError,
  makeUser,
  makeJob,
} = require('./smoke.harness');

const UserModel = require('../../models/energy_provider/UserModel');
const JobModel = require('../../models/energy_provider/JobModel');
const DocumentModel = require('../../models/energy_provider/DocumentModel');
const JobService = require('../../services/energy_provider/jobService');
const DeliveryService = require('../../services/energy_provider/deliveryService');
const DashboardService = require('../../services/energy_provider/dashboardService');
const EarningsService = require('../../services/energy_provider/earningsService');
const RegistrationService = require('../../services/energy_provider/registrationService');

module.exports = async function marketplaceCases({ partnerA, partnerB }) {
  console.log('\nDelivery workflow');
  const courier = await makeUser({
    mobile: '9000000003',
    role: 'service_partner',
    online: true,
  });

  const courierLicense = await DocumentModel.create({
    userId: courier.id,
    docType: 'driving_license_photo',
    fileName: 'courier-license.jpg',
    fileRef: 'smoke-test-courier-license',
  });
  const courierVerification = await RegistrationService.submitDeliveryVerification(courier.id, {
    vehicleType: 'Bike / Scooter',
    vehicleNumber: 'RJ14 XX 4321',
    licenseDocumentId: courierLicense.id,
  });
  await db.run('UPDATE `delivery_verifications` SET `status` = ? WHERE `id` = ?', [
    'approved',
    courierVerification.id,
  ]);

  const deliveryJob = await makeJob({
    referenceId: 'EC-IND-0003',
    jobType: 'delivery',
    targetRole: 'delivery_partner',
    serviceCharge: 0,
  });

  const deliveryJobs = await DeliveryService.listOpenJobs(courier);
  check('approved service partner can see delivery requests', deliveryJobs.some((job) => job.id === deliveryJob.id));
  check(
    'delivery requests expose only a masked customer phone',
    deliveryJobs[0].customerPhone === null && deliveryJobs[0].customerPhoneMasked === '******3210'
  );
  const deliveryAccepted = await DeliveryService.acceptJob(courier, deliveryJob.id);
  check('delivery job is accepted', deliveryAccepted.status === 'accepted');
  check('accepted delivery does not expose the customer phone', deliveryAccepted.customerPhone === null);
  check('delivery starts at the pickup stage', deliveryAccepted.stage === 'pickup');
  check('delivery assignment time is persisted', Boolean((await JobModel.findById(deliveryJob.id)).assigned_at));

  await expectError(
    'delivery completion needs the pickup photo',
    () => DeliveryService.completeDelivery(courier, deliveryJob.id),
    400
  );

  await DeliveryService.confirmArrival(courier, deliveryJob.id, {
    leg: 'pickup',
    photo: 'pickup.jpg',
  });
  let deliveryState = await JobModel.findById(deliveryJob.id);
  check('pickup advances to to_workshop', deliveryState.stage === 'to_workshop');

  await DeliveryService.confirmArrival(courier, deliveryJob.id, {
    leg: 'drop',
    photo: 'drop.jpg',
  });
  deliveryState = await JobModel.findById(deliveryJob.id);
  check('drop advances to delivered', deliveryState.stage === 'delivered');

  const deliveryDone = await DeliveryService.completeDelivery(courier, deliveryJob.id);
  check('delivery completes', deliveryDone.deliveryFee === 1000);
  check('delivery commission is 10 percent', deliveryDone.commission === 100);
  check('delivery payout is the net amount', deliveryDone.payoutAmount === 900);

  const courierAfter = await UserModel.findById(courier.id);
  check('delivery completion releases the busy flag', courierAfter.is_busy === 0);

  console.log('\nDelivery partner verification');
  const licenseDocument = await DocumentModel.create({
    userId: partnerA.id,
    docType: 'driving_license_photo',
    fileName: 'license.jpg',
    fileRef: 'smoke-test-license',
  });
  const verification = await RegistrationService.submitDeliveryVerification(partnerA.id, {
    vehicleType: 'Bike / Scooter',
    vehicleNumber: 'RJ14 XX 1234',
    licenseDocumentId: licenseDocument.id,
  });
  check('verification stores normalized vehicle details', verification.vehicleNumber === 'RJ14 XX 1234');
  check('verification starts pending', verification.status === 'pending');
  check(
    'partner can retrieve current verification',
    (await RegistrationService.getDeliveryVerification(partnerA.id))?.id === verification.id
  );
  await expectError(
    'pending verification cannot list delivery requests',
    () => DeliveryService.listOpenJobs(partnerA),
    403
  );
  const pendingDeliveryJob = await makeJob({
    referenceId: 'EC-IND-0009',
    jobType: 'delivery',
    targetRole: 'delivery_partner',
    serviceCharge: 0,
  });
  await expectError(
    'pending verification cannot accept delivery requests',
    () => DeliveryService.acceptJob(partnerA, pendingDeliveryJob.id),
    403
  );
  const deliveryRoleUser = await makeUser({
    mobile: '9000000008',
    role: 'delivery_partner',
  });
  await expectError(
    'non-service roles cannot list delivery requests',
    () => DeliveryService.listOpenJobs(deliveryRoleUser),
    403
  );
  await expectError(
    'delivery partners cannot submit the service-partner opt-in form',
    () => RegistrationService.submitDeliveryVerification(deliveryRoleUser.id, {
      vehicleType: 'Bike / Scooter',
      vehicleNumber: 'RJ14XX1234',
      licenseDocumentId: licenseDocument.id,
    }),
    403
  );
  await expectError(
    'another partner cannot submit someone else\'s license',
    () => RegistrationService.submitDeliveryVerification(partnerB.id, {
      vehicleType: 'Car',
      vehicleNumber: 'MH12AB1234',
      licenseDocumentId: licenseDocument.id,
    }),
    400
  );
  await expectError(
    'duplicate pending verification is blocked',
    () => RegistrationService.submitDeliveryVerification(partnerA.id, {
      vehicleType: 'Car',
      vehicleNumber: 'MH12AB1234',
      licenseDocumentId: licenseDocument.id,
    }),
    409
  );

  console.log('\nEarnings and dashboard');
  const earnings = await EarningsService.listEarnings(partnerA);
  check('earnings are recorded for the service job', earnings.length === 1);
  check('earning source is service', earnings[0].source === 'service');

  const summary = await EarningsService.getSummary(partnerA);
  check('earnings summary totals the net amount', summary.totalNet === 1458);
  check('earnings summary counts pending rows', summary.counts.pending === 1);

  const dashboard = await DashboardService.getDashboard(partnerA);
  check('dashboard reports the completed job', dashboard.stats.completedJobs === 1);
  check('dashboard reports the earnings', dashboard.stats.totalEarnings === 1458);
  check('dashboard reports the partner as idle', dashboard.profile.isBusy === false);

  const notifications = await DashboardService.listNotifications(partnerA);
  check('notifications were written', notifications.length >= 1);

  console.log('\nPII masking');
  const panelMaker = await makeUser({ mobile: '9000000004', role: 'panel_maker' });
  const workshop = await makeUser({ mobile: '9000000005', role: 'repairing_partner' });
  const openJob = await makeJob({ referenceId: 'EC-IND-0006', targetRole: 'panel_maker' });

  const panelView = await JobService.listOpenJobs(panelMaker);
  check('panel maker sees the job', panelView.length === 1);
  check('panel maker cannot see the customer name', panelView[0].customerName === 'Hidden');
  check('panel maker cannot see the customer phone', panelView[0].customerPhone === null);
  check('customer phone is masked separately', panelView[0].customerPhoneMasked === '******3210');

  const workshopView = await JobService.listOpenJobs(workshop);
  check('workshop partner sees no panel jobs', workshopView.length === 0);
  await expectError(
    'a partner cannot open job details for another role',
    () => JobService.getJobDetail(workshop, openJob.id),
    403
  );

  const panelDetail = await JobService.getJobDetail(panelMaker, openJob.id);
  check('panel maker detail hides the customer name', panelDetail.customerName === 'Hidden');

  const serviceJob = await makeJob({
    referenceId: 'EC-IND-0008',
    targetRole: 'service_partner',
  });
  const serviceView = await JobService.listOpenJobs(partnerA);
  check('service partner sees the customer name', serviceView[0].customerName === 'Ravi Kumar');
  check('service partner cannot receive the raw customer phone', serviceView[0].customerPhone === null);
  check('service partner receives only the masked customer phone', serviceView[0].customerPhoneMasked === '******3210');
  check('service job is the open one', serviceView[0].id === serviceJob.id);

  return { partnerA, partnerB };
};
