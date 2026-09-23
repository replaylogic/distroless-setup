import { Injectable } from '@angular/core';

import { environment } from '../environments/environment';

@Injectable({ providedIn: 'root' })
export class ApiService {
  /** Instance field: constructed after bootstrap, so this read is safe to rewrite. */
  readonly base = environment.apiBaseUrl;

  /** Method body: also runs after bootstrap. */
  url(p: string): string {
    return `${environment.apiBaseUrl}/${p}`;
  }

  /** Stays build-time: `production` is not moved into the runtime config. */
  get isProd(): boolean {
    return environment.production;
  }

  /** Flattened nested key. */
  get clientId(): string {
    return environment.auth.clientId;
  }
}
