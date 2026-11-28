import type { RepairTicket } from './operations.service';

export function repairStageStartedAt(ticket: RepairTicket): string {
  const stageEvent = [...(ticket.history ?? [])].reverse().find((event) =>
    event.status === ticket.status &&
    event.status !== 'workshop_details_updated' &&
    event.at &&
    Number.isFinite(Date.parse(event.at)),
  );
  return stageEvent?.at ?? ticket.inAt;
}

export function isSandboxRepair(ticket: RepairTicket): boolean {
  if (ticket.testRecord) return true;
  const searchableText = [
    ticket.ticketNumber,
    ticket.manufacturer,
    ticket.model,
    ticket.device,
    ticket.fault,
    ticket.symptoms,
    ticket.clientName,
  ].join(' ');
  return searchableText.split(/\s+/).some((token) => {
    const normalized = token.replace(/[^a-z]/gi, '').toLowerCase();
    return normalized.length >= 6 && new Set(normalized).size <= 3;
  }) || /\btest\s*(?:maker|ticket|device|account|panel)\b|\b(?:dummy|sandbox|demo|sample)\b/i
    .test(searchableText);
}
