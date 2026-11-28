/**
 * Energy Hub - normalised schema.
 *
 * Design rules kept deliberately minimal but correct:
 *  - every table has a surrogate primary key `id`
 *  - foreign keys are declared so referential integrity is enforced by the engine
 *  - state columns are plain strings (kept readable) with the allowed values
 *    documented next to them
 *  - `created_at` / `updated_at` are maintained by the application layer
 *
 * The same declaration is rendered for PostgreSQL, MySQL, and isolated SQLite
 * smoke tests. Runtime PostgreSQL connection settings come from the shared DB_* environment.
 */

const tables = {
  // ------------------------------------------------------------------
  // Identity & onboarding
  // ------------------------------------------------------------------
  users: {
    columns: {
      id: { type: 'id' },
      mobile: { type: 'text' },
      email: { type: 'text' },
      // service_partner | repairing_partner | panel_maker | supplier | delivery_partner | admin
      role: { type: 'text' },
      account_group_id: { type: 'int' },
      // pending | under_review | needs_information | approved | rejected | suspended
      status: { type: 'text', default: 'pending' },
      full_name: { type: 'text' },
      date_of_birth: { type: 'text' },
      address: { type: 'text', long: true },
      emergency_contact_name: { type: 'text' },
      emergency_contact_phone: { type: 'text' },
      profile_photo: { type: 'text' },
      business_name: { type: 'text' },
      years_experience: { type: 'text' },
      qualification: { type: 'text' },
      qualification_details: { type: 'text' },
      specialization_details: { type: 'json' },
      service_area_details: { type: 'json' },
      specialization_status: { type: 'text', default: 'unsubmitted' },
      // comma separated list of service areas
      service_areas: { type: 'text' },
      // 5 | 10 | 15 | 25 | 0 (0 = no limit)
      travel_radius_km: { type: 'int', default: 0 },
      bank_account_holder: { type: 'text' },
      bank_account_number: { type: 'text' },
      bank_ifsc: { type: 'text' },
      bank_name: { type: 'text' },
      rating: { type: 'real', default: 0 },
      jobs_completed: { type: 'int', default: 0 },
      // 0 = offline, 1 = online (only online partners receive offers)
      is_online: { type: 'bool', default: 0 },
      // 0 = not busy, 1 = busy (blocks further offers until completion)
      is_busy: { type: 'bool', default: 0 },
      partner_since: { type: 'datetime' },
      reference_id: { type: 'text' },
      created_at: { type: 'datetime' },
      updated_at: { type: 'datetime' },
    },
    indexes: [
      { name: 'mobile', columns: ['mobile'] },
      { name: 'mobile_role', columns: ['mobile', 'role'], unique: true },
      { name: 'role', columns: ['role'] },
      { name: 'status', columns: ['status'] },
    ],
  },

  otp_codes: {
    columns: {
      id: { type: 'id' },
      mobile: { type: 'text' },
      code: { type: 'text' },
      purpose: { type: 'text', default: 'login' },
      email: { type: 'text' },
      attempts: { type: 'int', default: 0 },
      expires_at: { type: 'datetime' },
      consumed_at: { type: 'datetime' },
      created_at: { type: 'datetime' },
    },
    indexes: [
      { name: 'mobile', columns: ['mobile'] },
      { name: 'expires', columns: ['expires_at'] },
    ],
  },

  partner_applications: {
    columns: {
      id: { type: 'id' },
      user_id: { type: 'int', references: { table: 'users', column: 'id' } },
      account_group_id: { type: 'int' },
      mobile: { type: 'text' },
      email: { type: 'text' },
      partner_role: { type: 'text' },
      // draft | under_review | needs_information | approved | rejected | suspended
      status: { type: 'text', default: 'draft' },
      current_step: { type: 'int', default: 0 },
      personal_details: { type: 'json' },
      professional_details: { type: 'json' },
      bank_details: { type: 'json' },
      service_areas: { type: 'text' },
      service_area_details: { type: 'json' },
      travel_radius_km: { type: 'int', default: 0 },
      qualification_details: { type: 'text' },
      specialization_details: { type: 'json' },
      categories: { type: 'json' },
      specializations: { type: 'json' },
      specialization_status: { type: 'text', default: 'unsubmitted' },
      consent: { type: 'bool', default: 0 },
      rejection_reason: { type: 'text' },
      reference_id: { type: 'text' },
      submitted_at: { type: 'datetime' },
      created_at: { type: 'datetime' },
      updated_at: { type: 'datetime' },
    },
    indexes: [
      { name: 'mobile', columns: ['mobile'] },
      { name: 'status', columns: ['status'] },
    ],
  },

  partner_documents: {
    columns: {
      id: { type: 'id' },
      application_id: { type: 'int', references: { table: 'partner_applications', column: 'id' } },
      user_id: { type: 'int', references: { table: 'users', column: 'id' } },
      // aadhar | pan | driving_license | address_proof | educational_certificate |
      // certification | business_registration | gst | workshop_address | owner_id |
      // oem_certificate | shop_license | driving_license_photo
      doc_type: { type: 'text' },
      file_name: { type: 'text' },
      file_ref: { type: 'text', long: true },
      mime_type: { type: 'text' },
      size_bytes: { type: 'int', default: 0 },
      // pending | verified | rejected
      status: { type: 'text', default: 'pending' },
      rejection_reason: { type: 'text' },
      created_at: { type: 'datetime' },
    },
    indexes: [
      { name: 'application', columns: ['application_id'] },
      { name: 'user', columns: ['user_id'] },
    ],
  },

  delivery_verifications: {
    columns: {
      id: { type: 'id' },
      user_id: { type: 'int', references: { table: 'users', column: 'id' } },
      // bike_scooter | car | van_tempo
      vehicle_type: { type: 'text' },
      vehicle_number: { type: 'text' },
      license_document_id: { type: 'int', references: { table: 'partner_documents', column: 'id' } },
      // pending | approved | rejected
      status: { type: 'text', default: 'pending' },
      rejection_reason: { type: 'text' },
      created_at: { type: 'datetime' },
      updated_at: { type: 'datetime' },
    },
    indexes: [{ name: 'user', columns: ['user_id'] }],
  },

  // ------------------------------------------------------------------
  // Marketplace
  // ------------------------------------------------------------------
  jobs: {
    columns: {
      id: { type: 'id' },
      // human readable reference e.g. EC-IND-0089
      reference_id: { type: 'text' },
      // service | repair | panel | delivery
      job_type: { type: 'text' },
      // which marketplace the job was published to
      target_role: { type: 'text' },
      title: { type: 'text' },
      description: { type: 'text', long: true },
      category: { type: 'text' },
      equipment: { type: 'text' },
      equipment_model: { type: 'text' },
      brand: { type: 'text' },
      issue_tags: { type: 'json' },
      // low | medium | high | urgent
      urgency: { type: 'text', default: 'medium' },
      customer_name: { type: 'text' },
      customer_company: { type: 'text' },
      customer_phone: { type: 'text' },
      site_address: { type: 'text', long: true },
      site_area: { type: 'text' },
      latitude: { type: 'real' },
      longitude: { type: 'real' },
      distance_km: { type: 'real', default: 0 },
      estimated_drive_minutes: { type: 'int', default: 0 },
      base_pay: { type: 'real', default: 0 },
      service_charge: { type: 'real', default: 0 },
      // open | accepted | in_progress | completed | cancelled | declined
      status: { type: 'text', default: 'open' },
      // service: accepted | checked_in | diagnosed | parts_used | photos_done | completed
      // repair:  received | diagnosing | repairing | ready | dispatched
      // panel:   received | design_quote | fabricating | qc | dispatched
      // delivery: pickup | to_workshop | delivered
      stage: { type: 'text' },
      // partner assigned to the job
      assigned_partner_id: { type: 'int', references: { table: 'users', column: 'id' } },
      assigned_at: { type: 'datetime' },
      scheduled_at: { type: 'text' },
      sla_due_at: { type: 'datetime' },
      sla_paused: { type: 'bool', default: 0 },
      // whether the customer asked for a repair-centre recommendation
      repair_center_recommended: { type: 'bool', default: 0 },
      // checklist + sign off
      customer_otp: { type: 'text' },
      checklist: { type: 'json' },
      total_bill: { type: 'real', default: 0 },
      parts_total: { type: 'real', default: 0 },
      payout_amount: { type: 'real', default: 0 },
      completed_at: { type: 'datetime' },
      created_at: { type: 'datetime' },
      updated_at: { type: 'datetime' },
    },
    indexes: [
      { name: 'reference', columns: ['reference_id'], unique: true },
      { name: 'status', columns: ['status'] },
      { name: 'target_role', columns: ['target_role'] },
      { name: 'assigned', columns: ['assigned_partner_id'] },
    ],
  },

  job_stage_history: {
    columns: {
      id: { type: 'id' },
      job_id: { type: 'int', references: { table: 'jobs', column: 'id' } },
      from_stage: { type: 'text' },
      to_stage: { type: 'text' },
      actor_id: { type: 'int', references: { table: 'users', column: 'id' } },
      note: { type: 'text' },
      created_at: { type: 'datetime' },
    },
    indexes: [{ name: 'job', columns: ['job_id'] }],
  },

  job_workflow_steps: {
    columns: {
      id: { type: 'id' },
      job_id: { type: 'int', references: { table: 'jobs', column: 'id' } },
      // 1..5 for the field workflow
      step_number: { type: 'int' },
      // checkin | diagnosis | parts | photos | signoff
      step_key: { type: 'text' },
      status: { type: 'text', default: 'pending' },
      findings: { type: 'text', long: true },
      issue_tags: { type: 'json' },
      diagnosis: { type: 'text', long: true },
      recommend_service_center: { type: 'bool', default: 0 },
      checked_in_at: { type: 'datetime' },
      completed_at: { type: 'datetime' },
      created_at: { type: 'datetime' },
      updated_at: { type: 'datetime' },
    },
    indexes: [
      { name: 'job', columns: ['job_id'] },
      { name: 'job_step', columns: ['job_id', 'step_number'], unique: true },
    ],
  },

  job_live_locations: {
    columns: {
      id: { type: 'id' },
      job_id: { type: 'int', references: { table: 'jobs', column: 'id' } },
      latitude: { type: 'real' },
      longitude: { type: 'real' },
      created_at: { type: 'datetime' },
      updated_at: { type: 'datetime' },
    },
    indexes: [
      { name: 'job', columns: ['job_id'], unique: true },
      { name: 'updated_at', columns: ['updated_at'] },
    ],
  },

  job_parts: {
    columns: {
      id: { type: 'id' },
      job_id: { type: 'int', references: { table: 'jobs', column: 'id' } },
      part_name: { type: 'text' },
      quantity: { type: 'int', default: 1 },
      unit_cost: { type: 'real', default: 0 },
      line_total: { type: 'real', default: 0 },
      created_at: { type: 'datetime' },
    },
    indexes: [{ name: 'job', columns: ['job_id'] }],
  },

  job_photos: {
    columns: {
      id: { type: 'id' },
      job_id: { type: 'int', references: { table: 'jobs', column: 'id' } },
      // before | after | pickup | drop
      photo_type: { type: 'text' },
      file_name: { type: 'text' },
      file_ref: { type: 'text', long: true },
      created_at: { type: 'datetime' },
    },
    indexes: [{ name: 'job', columns: ['job_id'] }],
  },

  job_partner_responses: {
    columns: {
      id: { type: 'id' },
      job_id: { type: 'int', references: { table: 'jobs', column: 'id' } },
      partner_id: { type: 'int', references: { table: 'users', column: 'id' } },
      // accepted | declined
      response: { type: 'text' },
      decline_reason: { type: 'text' },
      created_at: { type: 'datetime' },
    },
    indexes: [
      { name: 'job', columns: ['job_id'] },
      { name: 'job_partner', columns: ['job_id', 'partner_id'], unique: true },
    ],
  },

  // ------------------------------------------------------------------
  // Supplier commerce
  // ------------------------------------------------------------------
  products: {
    columns: {
      id: { type: 'id' },
      supplier_id: { type: 'int', references: { table: 'users', column: 'id' } },
      name: { type: 'text' },
      // Switchgear | Cables & Wires | VFD / Drives | PLC / Automation |
      // Panel Components | Tools & Safety
      category: { type: 'text' },
      brand: { type: 'text' },
      description: { type: 'text', long: true },
      price: { type: 'real', default: 0 },
      stock: { type: 'int', default: 0 },
      sku: { type: 'text' },
      image_ref: { type: 'text' },
      // active | out_of_stock | delisted
      status: { type: 'text', default: 'active' },
      created_at: { type: 'datetime' },
      updated_at: { type: 'datetime' },
    },
    indexes: [
      { name: 'supplier', columns: ['supplier_id'] },
      { name: 'status', columns: ['status'] },
      { name: 'sku', columns: ['sku'] },
    ],
  },

  // ------------------------------------------------------------------
  // Earnings / inventory / notifications / audit
  // ------------------------------------------------------------------
  earnings: {
    columns: {
      id: { type: 'id' },
      partner_id: { type: 'int', references: { table: 'users', column: 'id' } },
      job_id: { type: 'int', references: { table: 'jobs', column: 'id' } },
      // service | delivery
      source: { type: 'text' },
      gross_amount: { type: 'real', default: 0 },
      commission: { type: 'real', default: 0 },
      deductions: { type: 'real', default: 0 },
      net_amount: { type: 'real', default: 0 },
      // pending | paid | failed
      status: { type: 'text', default: 'pending' },
      payout_date: { type: 'datetime' },
      bank_reference: { type: 'text' },
      created_at: { type: 'datetime' },
    },
    indexes: [
      { name: 'partner', columns: ['partner_id'] },
      { name: 'source', columns: ['source'] },
      { name: 'status', columns: ['status'] },
    ],
  },

  inventory_items: {
    columns: {
      id: { type: 'id' },
      partner_id: { type: 'int', references: { table: 'users', column: 'id' } },
      name: { type: 'text' },
      sku: { type: 'text' },
      category: { type: 'text' },
      quantity: { type: 'int', default: 0 },
      reorder_level: { type: 'int', default: 0 },
      unit_cost: { type: 'real', default: 0 },
      created_at: { type: 'datetime' },
      updated_at: { type: 'datetime' },
    },
    indexes: [{ name: 'partner', columns: ['partner_id'] }],
  },

  notifications: {
    columns: {
      id: { type: 'id' },
      partner_id: { type: 'int', references: { table: 'users', column: 'id' } },
      job_id: { type: 'int', references: { table: 'jobs', column: 'id' } },
      type: { type: 'text' },
      title: { type: 'text' },
      body: { type: 'text', long: true },
      is_read: { type: 'bool', default: 0 },
      created_at: { type: 'datetime' },
    },
    indexes: [{ name: 'partner', columns: ['partner_id'] }],
  },

  audit_logs: {
    columns: {
      id: { type: 'id' },
      actor_id: { type: 'int', references: { table: 'users', column: 'id' } },
      entity: { type: 'text' },
      entity_id: { type: 'int' },
      action: { type: 'text' },
      before_state: { type: 'json' },
      after_state: { type: 'json' },
      ip_address: { type: 'text' },
      created_at: { type: 'datetime' },
    },
    indexes: [
      { name: 'entity', columns: ['entity', 'entity_id'] },
      { name: 'actor', columns: ['actor_id'] },
    ],
  },
};

module.exports = { tables };
