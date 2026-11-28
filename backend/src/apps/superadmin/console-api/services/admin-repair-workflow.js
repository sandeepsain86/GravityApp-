const { pool } = require('../../../../config/energy_service/db');

const DEFAULT_STAGE_TRANSITIONS = {
  received: { from: ['submitted'], to: 'received' },
  diagnosis: { from: ['received'], to: 'diagnosis' },
  quote_approval: { from: ['diagnosis'], to: 'estimate_required' },
  repairing: { from: ['approved'], to: 'repair_in_progress' },
  qc_passed: { from: ['repair_in_progress'], to: 'ready' },
  delivered: { from: ['ready'], to: 'returned' },
};

let stageTransitionsCache = null;
let stageTransitionsCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;
let STAGE_TRANSITIONS = { ...DEFAULT_STAGE_TRANSITIONS };

async function loadRepairStageTransitions() {
  const now = Date.now();
  if (stageTransitionsCache && now - stageTransitionsCacheTime < CACHE_TTL_MS) {
    STAGE_TRANSITIONS = stageTransitionsCache;
    return stageTransitionsCache;
  }
  try {
    const { rows } = await pool.query(
      `SELECT from_stage, to_stage FROM superadmin.repair_stage_transitions ORDER BY from_stage, to_stage`
    );
    if (rows && rows.length > 0) {
      const transitions = {};
      for (const row of rows) {
        if (!transitions[row.from_stage]) transitions[row.from_stage] = [];
        transitions[row.from_stage].push(row.to_stage);
      }
      // Convert to the expected format
      const result = {};
      const stageOrder = ['received', 'diagnosis', 'quote_approval', 'repairing', 'qc_passed', 'delivered'];
      for (const stage of stageOrder) {
        if (transitions[stage]) {
          result[stage] = { from: [], to: stage };
          // Find the source stage from reverse mapping
          for (const [fromStage, toStages] of Object.entries(transitions)) {
            if (toStages.includes(stage)) {
              result[stage].from = [fromStage];
            }
          }
        }
      }
      stageTransitionsCache = result;
      stageTransitionsCacheTime = now;
      STAGE_TRANSITIONS = result;
      return result;
    }
  } catch (error) {
    // Fall back to defaults
  }
  STAGE_TRANSITIONS = { ...DEFAULT_STAGE_TRANSITIONS };
  return STAGE_TRANSITIONS;
}

function workflowError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseMetadata(rows) {
  const metadata = {};
  for (const row of rows) {
    const match = String(row.remarks || '').match(/GH_REPAIR_METADATA:(\{.*?\})(?:\n|$)/);
    if (!match) continue;
    try {
      Object.assign(metadata, JSON.parse(match[1]));
    } catch {}
  }
  return metadata;
}

function createAdminRepairWorkflowService(pool) {
  return {
    async transitionStage(reference, targetStage, remarks, details = {}, actor) {
      if (actor === undefined && details && details.name && details.email) {
        actor = details;
        details = {};
      }
      const transition = STAGE_TRANSITIONS[targetStage];
      if (!transition) throw workflowError('The requested repair stage is not supported.', 400);
      if (targetStage === 'qc_passed' && (typeof remarks !== 'string' || !remarks.trim())) {
        throw workflowError('A QC note is required before marking the repair as QC passed.', 400);
      }
      if (targetStage === 'quote_approval' &&
          (!(Number(details?.estimatedCost) > 0))) {
        throw workflowError('An estimated cost greater than zero is required before submitting the customer quote.', 400);
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const selected = await client.query(
          `SELECT id, ticket_number, status
             FROM public.repair_tickets
            WHERE id::text = $1 OR ticket_number = $1
            FOR UPDATE`,
          [reference],
        );
        const ticket = selected.rows[0];
        if (!ticket) throw workflowError('The repair ticket was not found.', 404);
        if (!transition.from.includes(ticket.status)) {
          const message = targetStage === 'repairing' && ticket.status === 'estimate_required'
            ? 'Repair cannot start until the customer approves the estimate.'
            : `The repair ticket cannot move from "${ticket.status}" to "${targetStage}".`;
          throw workflowError(message, 409);
        }

        if (targetStage === 'repairing') {
          const parts = Array.isArray(details?.parts) ? details.parts : [];
          for (const part of parts) {
            if (!part?.sku || !Number.isInteger(Number(part.quantity)) || Number(part.quantity) < 1) {
              throw workflowError('Each selected spare part must have a valid SKU and quantity.', 400);
            }
            const stock = await client.query(
              `UPDATE energy_provider.inventory_items
                  SET quantity = quantity - $2, updated_at = NOW()
                WHERE sku = $1 AND quantity >= $2
                RETURNING id, sku, quantity`,
              [String(part.sku).trim(), Number(part.quantity)],
            );
            if (!stock.rows[0]) {
              throw workflowError(`Insufficient inventory for spare part ${part.sku}.`, 409);
            }
          }
        }

        const metadata = {};
        if (targetStage === 'quote_approval') metadata.estimatedCost = Number(details?.estimatedCost);
        if (targetStage === 'repairing') metadata.quoteApproved = true;
        if (Array.isArray(details?.parts)) metadata.spareParts = details.parts;
        if (details?.benchPartnerId) {
          metadata.benchPartnerId = String(details.benchPartnerId);
          metadata.benchPartnerName = String(details.benchPartnerName || details.benchPartnerId);
        }
        if (targetStage === 'repairing' && Array.isArray(details?.parts) && details.parts.length) {
          const history = await client.query(
            `SELECT remarks
               FROM public.repair_status_history
              WHERE repair_ticket_id = $1
              ORDER BY created_at, id`,
            [ticket.id],
          );
          const currentMetadata = parseMetadata(history.rows);
          const issuedSkus = new Set(details.parts.map((part) => String(part.sku)));
          if (Array.isArray(currentMetadata.partRequests)) {
            metadata.partRequests = currentMetadata.partRequests.map((request) =>
              issuedSkus.has(String(request.sku)) && request.status === 'requested'
                ? { ...request, status: 'issued' }
                : request,
            );
          }
        }

        const updated = await client.query(
          `UPDATE public.repair_tickets
              SET status = $2, updated_at = NOW()
            WHERE id = $1
            RETURNING id, ticket_number, status, updated_at`,
          [ticket.id, transition.to],
        );
        const metadataLine = Object.keys(metadata).length
          ? `GH_REPAIR_METADATA:${JSON.stringify(metadata)}\n`
          : '';
        const note = `${metadataLine}${remarks
          ? `${remarks}\n`
          : ''}Updated by Superadmin ${actor.name} (${actor.email}).`;
        await client.query(
          `INSERT INTO public.repair_status_history
             (repair_ticket_id, old_status, new_status, changed_by, remarks)
           VALUES ($1, $2, $3, NULL, $4)`,
          [ticket.id, ticket.status, transition.to, note],
        );
        await client.query('COMMIT');

        return {
          id: updated.rows[0].id,
          ticketNumber: updated.rows[0].ticket_number,
          status: updated.rows[0].status,
          stage: targetStage,
          fromStatus: ticket.status,
          updatedAt: updated.rows[0].updated_at,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async updateWorkshopDetails(reference, changes = {}, actor) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const selected = await client.query(
          `SELECT id, ticket_number, status
             FROM public.repair_tickets
            WHERE id::text = $1 OR ticket_number = $1
            FOR UPDATE`,
          [reference],
        );
        const ticket = selected.rows[0];
        if (!ticket) throw workflowError('The repair ticket was not found.', 404);
        if (['draft', 'cancelled', 'returned', 'completed'].includes(String(ticket.status).toLowerCase())) {
          throw workflowError('Workshop details cannot be changed for a closed repair ticket.', 409);
        }

        const history = await client.query(
          `SELECT remarks
             FROM public.repair_status_history
            WHERE repair_ticket_id = $1
            ORDER BY created_at, id`,
          [ticket.id],
        );
        const metadata = parseMetadata(history.rows);

        if (Object.prototype.hasOwnProperty.call(changes, 'benchPartnerId')) {
          if (changes.benchPartnerId === null) {
            metadata.benchPartnerId = null;
            metadata.benchPartnerName = null;
          } else {
            const partnerResult = await client.query(
              `SELECT id, full_name, business_name
                 FROM energy_provider.users
                WHERE id::text = $1
                  AND LOWER(role) IN ('repairing', 'repairing_partner', 'service', 'service_partner')
                  AND LOWER(status) IN ('active', 'approved')`,
              [String(changes.benchPartnerId)],
            );
            const partner = partnerResult.rows[0];
            if (!partner) throw workflowError('Choose an active, verified service or repair partner.', 409);
            metadata.benchPartnerId = String(partner.id);
            metadata.benchPartnerName = String(partner.business_name || partner.full_name || partner.id);
          }
        }

        if (changes.partRequest) {
          const partResult = await client.query(
            `SELECT sku, name
               FROM energy_provider.inventory_items
              WHERE sku = $1`,
            [String(changes.partRequest.sku).trim()],
          );
          const part = partResult.rows[0];
          if (!part) throw workflowError('The selected inventory part was not found.', 404);
          const partRequests = Array.isArray(metadata.partRequests) ? metadata.partRequests : [];
          partRequests.push({
            sku: String(part.sku),
            name: String(part.name),
            quantity: Number(changes.partRequest.quantity),
            status: 'requested',
            requestedAt: new Date().toISOString(),
          });
          metadata.partRequests = partRequests;
        }

        const updated = await client.query(
          `UPDATE public.repair_tickets
              SET updated_at = NOW()
            WHERE id = $1
            RETURNING updated_at`,
          [ticket.id],
        );
        const updatedAt = new Date(updated.rows[0].updated_at).toISOString();
        const metadataLine = `GH_REPAIR_METADATA:${JSON.stringify(metadata)}\n`;
        await client.query(
          `INSERT INTO public.repair_status_history
             (repair_ticket_id, old_status, new_status, changed_by, remarks)
           VALUES ($1, $2, $2, NULL, $3)`,
          [
            ticket.id,
            ticket.status,
            `${metadataLine}Workshop details updated by Superadmin ${actor.name} (${actor.email}).`,
          ],
        );
        await client.query('COMMIT');

        return {
          id: ticket.id,
          ticketNumber: ticket.ticket_number,
          status: ticket.status,
          stage: 'workshop_update',
          fromStatus: ticket.status,
          updatedAt,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async assignPartnerToRepairs(references, partnerId, actor) {
      const uniqueReferences = [...new Set(references.map((reference) => String(reference).trim()))];
      if (!uniqueReferences.length || uniqueReferences.length > 100 || uniqueReferences.some((reference) => !reference)) {
        throw workflowError('Select between 1 and 100 valid repair tickets.', 400);
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const partnerResult = await client.query(
          `SELECT id, full_name, business_name
             FROM energy_provider.users
            WHERE id::text = $1
              AND LOWER(role) IN ('repairing', 'repairing_partner', 'service', 'service_partner')
              AND LOWER(status) IN ('active', 'approved')`,
          [String(partnerId)],
        );
        const partner = partnerResult.rows[0];
        if (!partner) throw workflowError('Choose an active, verified service or repair partner.', 409);

        const selected = await client.query(
          `SELECT id, ticket_number, status
             FROM public.repair_tickets
            WHERE id::text = ANY($1::text[]) OR ticket_number = ANY($1::text[])
            ORDER BY id
            FOR UPDATE`,
          [uniqueReferences],
        );
        if (selected.rows.length !== uniqueReferences.length) {
          throw workflowError('One or more selected repair tickets could not be found.', 404);
        }
        const closed = selected.rows.find((ticket) =>
          ['draft', 'cancelled', 'returned', 'completed'].includes(String(ticket.status).toLowerCase()),
        );
        if (closed) throw workflowError(`Repair ticket ${closed.ticket_number} is closed and cannot be assigned.`, 409);

        const ids = selected.rows.map((ticket) => ticket.id);
        const history = await client.query(
          `SELECT repair_ticket_id, remarks
             FROM public.repair_status_history
            WHERE repair_ticket_id = ANY($1::uuid[])
            ORDER BY created_at, id`,
          [ids],
        );
        const metadataByTicket = new Map();
        const historyByTicket = new Map();
        for (const row of history.rows) {
          const key = String(row.repair_ticket_id);
          const entries = historyByTicket.get(key) || [];
          entries.push(row);
          historyByTicket.set(key, entries);
        }
        for (const [key, entries] of historyByTicket) {
          metadataByTicket.set(key, parseMetadata(entries));
        }

        const updatedRows = [];
        for (const ticket of selected.rows) {
          const metadata = metadataByTicket.get(String(ticket.id)) || {};
          metadata.benchPartnerId = String(partner.id);
          metadata.benchPartnerName = String(partner.business_name || partner.full_name || partner.id);
          const updated = await client.query(
            `UPDATE public.repair_tickets
                SET updated_at = NOW()
              WHERE id = $1
              RETURNING updated_at`,
            [ticket.id],
          );
          await client.query(
            `INSERT INTO public.repair_status_history
               (repair_ticket_id, old_status, new_status, changed_by, remarks)
             VALUES ($1, $2, $2, NULL, $3)`,
            [
              ticket.id,
              ticket.status,
              `GH_REPAIR_METADATA:${JSON.stringify(metadata)}\nWorkshop partner assigned in bulk by Superadmin ${actor.name} (${actor.email}).`,
            ],
          );
          updatedRows.push({
            id: ticket.id,
            ticketNumber: ticket.ticket_number,
            status: ticket.status,
            stage: 'workshop_update',
            fromStatus: ticket.status,
            updatedAt: new Date(updated.rows[0].updated_at).toISOString(),
          });
        }
        await client.query('COMMIT');
        return { partnerId: String(partner.id), partnerName: String(partner.business_name || partner.full_name || partner.id), repairs: updatedRows };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

module.exports = {
  createAdminRepairWorkflowService,
  loadRepairStageTransitions,
  get STAGE_TRANSITIONS() { return STAGE_TRANSITIONS; },
  DEFAULT_STAGE_TRANSITIONS,
};
