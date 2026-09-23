import { Component, inject } from '@angular/core';

import { ApiService } from './api.service';

@Component({
  selector: 'app-root',
  standalone: true,
  template: `
    <h1>fixture-spa</h1>
    <p id="api-base">{{ api.base }}</p>
    <p id="api-url">{{ api.url('widgets') }}</p>
    <p id="is-prod">{{ api.isProd }}</p>
  `,
})
export class App {
  readonly api = inject(ApiService);
}
