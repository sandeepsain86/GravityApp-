/**
 * Smoke test - part 1: job acceptance, guards and the five step workflow.
 */

const {
  db,
  state,
  check,
  expectError,
  makeUser,
  makeJob,
  fullChecklist,
} = require('./smoke.harness');

const UserModel = require('../../models/energy_provider/UserModel');
const JobModel = require('../../models/energy_provider/JobModel');
const JobService = require('../../services/energy_provider/jobService');

module.exports = async function acceptanceCases() {
  console.log('Job acceptance');
  const partnerA = await makeUser({
    mobile: '9000000001',
    role: 'service_partner',
    online: true,
  });
  const partnerB = await makeUser({
    mobile: '9000000002',
    role: 'service_partner',
    online: true,
  });

  const job = await makeJob({ referenceId: 'EC-IND-0001', targetRole: 'service_partner' });

  const openJobs = await JobService.listOpenJobs(partnerA);
  check('open job is listed for the marketplace', openJobs.length === 1);

  const accepted = await JobService.acceptJob(partnerA, job.id);
  check('job is accepted', accepted.status === 'accepted');
  check(
    'job is assigned to the partner',
    String(accepted.assignedPartnerId) === String(partnerA.id)
  );
  check('job assignment time is persisted', Boolean((await JobModel.findById(job.id)).assigned_at));

  const busyA = await UserModel.findById(partnerA.id);
  check('accepting marks the partner busy', busyA.is_busy === 1);

  const steps = await JobService.workflowSteps();
  check('five workflow steps are defined', steps.length === 5);

  const detail = await JobService.getJobDetail(partnerA, job.id);
  check('workflow rows were seeded', detail.workflow.length === 5);
  check('seeded steps start pending', detail.workflow.every((s) => s.status === 'pending'));

  console.log('\nAcceptance guards');
  await expectError(
    'a second partner cannot accept the same job',
    () => JobService.acceptJob(partnerB, job.id),
    409
  );
  const busyB = await UserModel.findById(partnerB.id);
  check('failed acceptance leaves the loser not busy', busyB.is_busy === 0);

  await expectError(
    'a busy partner cannot accept another job',
    () => JobService.acceptJob(partnerA, job.id),
    409
  );

  const secondOfferJob = await makeJob({
    referenceId: 'EC-IND-0010',
    targetRole: 'service_partner',
  });
  await expectError(
    'one partner cannot accept another job while already busy',
    () => JobService.acceptJob(partnerA, secondOfferJob.id),
    409
  );
  check('a job rejected for a busy partner remains open for other partners', (await JobModel.findById(secondOfferJob.id)).status === 'open');
  await JobModel.updateById(secondOfferJob.id, { status: 'cancelled' });

  const offlineJob = await makeJob({
    referenceId: 'EC-IND-0002',
    targetRole: 'service_partner',
  });
  const offlinePartner = await makeUser({
    mobile: '9000000007',
    role: 'service_partner',
    online: false,
  });
  await expectError(
    'an offline partner cannot accept a job',
    () => JobService.acceptJob(offlinePartner, offlineJob.id),
    400
  );
  const busyOffline = await UserModel.findById(offlinePartner.id);
  check('failed offline acceptance releases the busy flag', busyOffline.is_busy === 0);

  // The offline job is still open, so it stays visible in the marketplace.
  // Close it out so later assertions see a predictable job list.
  await JobModel.updateById(offlineJob.id, { status: 'cancelled' });

  console.log('\nFive step field workflow');
  await JobService.checkIn(partnerA, job.id);
  let current = await JobModel.findById(job.id);
  check('check-in advances the stage', current.stage === 'checked_in');
  await expectError(
    'another partner cannot update a job live location',
    () => JobService.recordLiveLocation(partnerB, job.id, { latitude: 18.52, longitude: 73.85 }),
    403
  );
  await expectError(
    'live location rejects out-of-range coordinates',
    () => JobService.recordLiveLocation(partnerA, job.id, { latitude: 91, longitude: 73.85 }),
    400
  );
  const liveLocation = await JobService.recordLiveLocation(partnerA, job.id, {
    latitude: 18.5204,
    longitude: 73.8567,
  });
  check('checked-in partner can publish a live location', liveLocation.jobId === job.id && !!liveLocation.updatedAt);
  const assignedAfterCheckIn = await JobService.listMyJobs(partnerA);
  check('assigned job exposes the actual check-in time', !!assignedAfterCheckIn.find((item) => item.id === job.id)?.startedAt);

  await JobService.saveDiagnosis(partnerA, job.id, {
    findings: 'Output phase fault on the drive',
    issueTags: ['Overcurrent', 'Output phase fault'],
    diagnosis: 'IGBT module damaged',
    recommendServiceCenter: true,
  });
  current = await JobModel.findById(job.id);
  check('diagnosis advances the stage', current.stage === 'diagnosed');
  check('diagnosis recommendation is visible on the active job', current.repair_center_recommended === 1);

  await expectError(
    'workshop-only parts are rejected on site',
    () =>
      JobService.saveParts(partnerA, job.id, {
        parts: [{ name: 'IGBT module', quantity: 1, unitCost: 5000 }],
      }),
    400
  );
  await expectError(
    'PCB is rejected on site',
    () =>
      JobService.saveParts(partnerA, job.id, {
        parts: [{ name: 'PCB board', quantity: 1, unitCost: 2000 }],
      }),
    400
  );

  const savedParts = await JobService.saveParts(partnerA, job.id, {
    parts: [
      { name: 'Cooling fan', quantity: 2, unitCost: 350 },
      { name: 'Fuse', quantity: 1, unitCost: 120 },
    ],
  });
  check('site replaceable parts are accepted', savedParts.parts.length === 2);
  check('parts total is calculated', savedParts.partsTotal === 820);

  await expectError(
    'photos require both a before and an after shot',
    () => JobService.savePhotos(partnerA, job.id, { photos: [{ type: 'before' }] }),
    400
  );

  const photos = await JobService.savePhotos(partnerA, job.id, {
    photos: [
      { type: 'before', fileName: 'before.jpg' },
      { type: 'after', fileName: 'after.jpg' },
    ],
  });
  check('photos are saved', photos.photoCount === 2);

  await expectError(
    'completion requires the full checklist',
    () =>
      JobService.completeJob(partnerA, job.id, {
        customerOtp: '1234',
        checklist: [{ id: 'work_completed', checked: true }],
      }),
    400
  );

  await expectError(
    'completion requires a customer OTP',
    () =>
      JobService.completeJob(partnerA, job.id, {
        customerOtp: '',
        checklist: fullChecklist,
      }),
    400
  );

  const completion = await JobService.completeJob(partnerA, job.id, {
    customerOtp: '4821',
    checklist: fullChecklist,
  });
  check('job completes', completion.status === 'completed');
  check(
    'completing removes the live location',
    !(await db.get('SELECT job_id FROM job_live_locations WHERE job_id = ?', [job.id]))
  );
  check('total bill includes parts and service charge', completion.totalBill === 1620);
  check('platform commission is 10 percent', completion.commission === 162);
  check('payout is the net amount', completion.payoutAmount === 1458);

  const afterComplete = await UserModel.findById(partnerA.id);
  check('completing releases the busy flag', afterComplete.is_busy === 0);
  check('completing increments the job counter', afterComplete.jobs_completed === 1);

  await expectError(
    'a completed job cannot be completed again',
    () =>
      JobService.completeJob(partnerA, job.id, {
        customerOtp: '4821',
        checklist: fullChecklist,
      }),
    409
  );

  return { partnerA, partnerB };
};
