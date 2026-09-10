import { Component } from '@angular/core';
import { ChatWidgetComponent } from '../lib/ui/chat-widget.component';

/**
 * A page for the assistant to sit on.
 *
 * Not part of the package - `public-api.ts` does not export it. It exists so that
 * `npm start` shows something working rather than a blank document, and so the widget can be
 * exercised against a real API without standing up the whole RoomRaah frontend.
 */
@Component({
  selector: 'app-demo',
  standalone: true,
  imports: [ChatWidgetComponent],
  template: `
    <main class="page">
      <h1>RoomRaah Chat Assistant</h1>
      <p class="lede">
        The bubble in the corner is the whole package. Ask it something the way a person
        actually types &mdash; in Roman Urdu, English, or a mix of both.
      </p>

      <ul class="examples">
        <li>mere nazdeek 25k tak boys hostel chahiye wifi aur mess ke sath</li>
        <li>Lahore mein 18000 tak koi girls hostel hai?</li>
        <li>I need a shared room under 20000 near Punjab University</li>
      </ul>

      <p class="note">
        Searching, ranking and distance all run against the live RoomRaah API and work today.
        The replies themselves need <code>POST /ai/parse</code> and <code>POST /ai/compose</code>,
        which are specified in <code>AI_ENDPOINTS_CONTRACT.md</code> and not deployed yet &mdash;
        until they are, the assistant says so rather than pretending.
      </p>
    </main>

    <app-chat-widget />
  `,
  styles: [
    `
      .page {
        max-width: 42rem;
        margin: 0 auto;
        padding: 4rem 1.5rem;
      }

      h1 {
        margin: 0 0 0.5rem;
        font-size: 1.875rem;
        font-weight: 700;
        color: #123b5d;
      }

      .lede {
        margin: 0 0 2rem;
        font-size: 1.125rem;
        color: #475569;
      }

      .examples {
        margin: 0 0 2rem;
        padding: 1rem 1rem 1rem 2.25rem;
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        color: #334155;
      }

      .examples li + li {
        margin-top: 0.5rem;
      }

      .note {
        margin: 0;
        font-size: 0.875rem;
        line-height: 1.625;
        color: #64748b;
      }

      code {
        padding: 0.1rem 0.3rem;
        font-size: 0.8125rem;
        background: #f1f5f9;
        border-radius: 4px;
      }
    `,
  ],
})
export class DemoComponent {}
