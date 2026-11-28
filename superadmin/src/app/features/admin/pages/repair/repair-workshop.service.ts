import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

const API_PREFIX = '/api/superadmin/console';

@Injectable({ providedIn: 'root' })
export class RepairWorkshopService {
  private readonly http = inject(HttpClient);

  async update(
    reference: string,
    changes: {
      benchPartnerId?: string | null;
      partRequest?: { sku: string; quantity: number };
    },
  ): Promise<void> {
    await firstValueFrom(
      this.http.patch(
        `${API_PREFIX}/admin/operations/repairs/${encodeURIComponent(reference)}/workshop`,
        changes,
        { withCredentials: true },
      ),
    );
  }

  async assignMany(references: string[], partnerId: string): Promise<void> {
    await firstValueFrom(
      this.http.patch(
        `${API_PREFIX}/admin/operations/repairs/assignment`,
        { references, partnerId },
        { withCredentials: true },
      ),
    );
  }
}
