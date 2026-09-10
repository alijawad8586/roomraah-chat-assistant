import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild, inject, signal } from '@angular/core';
import { of } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';
import { ChatService } from '../chat/chat.service';
import { ChatMessage } from '../models/chat.model';
import { ButtonComponent } from './button/button.component';
import { EmptyStateComponent } from './empty-state/empty-state.component';
import { SpinnerComponent } from './spinner/spinner.component';

/**
 * What the widget says when something failed that `ChatService` does not have wording for.
 *
 * Every status the contract documents already comes back as an ordinary assistant message, so
 * this is only reached by the things no contract covers: the network dropping, CORS refusing
 * the request, a 500 out of nowhere. One sentence and a retry button, because there is
 * nothing more specific to say.
 */
export const UNEXPECTED_ERROR_TEXT = 'Kuch ghalat ho gaya, dobara koshish karein.';

/**
 * The chat bubble, and the panel it opens into.
 *
 * Deliberately thin: it renders `ChatMessage`s and hands text back. Every decision about what
 * a message means - which endpoint failed, what to say about it, when to ask for a budget -
 * belongs to `ChatService`, which is why the only error handling here is for the failures
 * that service cannot see.
 *
 * The three primitives it uses travel with it, so the package has no design-system
 * dependency on the host application beyond the SCSS tokens in `src/styles`.
 */
@Component({
  selector: 'app-chat-widget',
  standalone: true,
  imports: [CommonModule, ButtonComponent, SpinnerComponent, EmptyStateComponent],
  templateUrl: './chat-widget.component.html',
  styleUrls: ['./chat-widget.component.scss'],
})
export class ChatWidgetComponent {
  private readonly chat = inject(ChatService);

  @ViewChild('log') private logRef?: ElementRef<HTMLElement>;

  readonly isOpen = signal(false);
  readonly messages = signal<ChatMessage[]>([]);
  readonly sending = signal(false);
  readonly draft = signal('');

  /**
   * The text of the turn that failed unexpectedly, kept so the retry button has something to
   * resend. Null whenever there is nothing to retry, which is also what hides the button.
   */
  readonly failedText = signal<string | null>(null);

  open(): void {
    this.isOpen.set(true);
  }

  close(): void {
    this.isOpen.set(false);
  }

  toggle(): void {
    this.isOpen.update((open) => !open);
  }

  onInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  /** Plain `submit` rather than `ngSubmit`, so the composer needs no `FormsModule`. */
  onSubmit(event: Event): void {
    event.preventDefault();
    this.submit();
  }

  /** Submitting the composer. Guards against an empty message and against double-sending. */
  submit(): void {
    const text = this.draft().trim();
    if (!text || this.sending()) return;

    this.draft.set('');
    this.messages.update((current) => [
      ...current,
      { role: 'user', text, timestamp: Date.now() },
    ]);
    this.dispatch(text);
  }

  /**
   * Resends the turn that failed, without adding a second copy of the person's message - they
   * asked once. The failure notice is dropped first, so a second failure does not stack.
   */
  retry(): void {
    const text = this.failedText();
    if (!text || this.sending()) return;

    this.messages.update((current) =>
      current.length > 0 && current[current.length - 1].role === 'assistant'
        ? current.slice(0, -1)
        : current,
    );
    this.dispatch(text);
  }

  /**
   * One round trip.
   *
   * `finalize` rather than clearing the flag in both handlers: it runs on success, on error
   * and on unsubscribe alike, so there is no path - including the panel being closed
   * mid-search - that can leave the typing indicator spinning forever.
   *
   * The reply is read back from `ChatService.getHistory()` rather than from the emission,
   * because the service is the one holding the conversation and reading it back keeps the two
   * from drifting.
   */
  private dispatch(text: string): void {
    this.failedText.set(null);
    this.sending.set(true);

    this.chat
      .handleUserMessage(text)
      .pipe(
        catchError(() => {
          this.failedText.set(text);
          return of(null);
        }),
        finalize(() => {
          this.sending.set(false);
          this.scrollToLatest();
        }),
      )
      .subscribe((reply) => {
        this.messages.set(
          reply
            ? this.chat.getHistory()
            : [
                ...this.messages(),
                { role: 'assistant', text: UNEXPECTED_ERROR_TEXT, timestamp: Date.now() },
              ],
        );
        this.scrollToLatest();
      });
  }

  /** Deferred a tick, because the message that prompted it has not been rendered yet. */
  private scrollToLatest(): void {
    setTimeout(() => {
      const log = this.logRef?.nativeElement;
      if (log) log.scrollTop = log.scrollHeight;
    });
  }
}
