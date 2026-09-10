import { Injectable } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Observable, Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatService } from '../chat/chat.service';
import { ChatMessage } from '../models/chat.model';
import { ChatWidgetComponent, UNEXPECTED_ERROR_TEXT } from './chat-widget.component';

/**
 * A stand-in for the orchestrator that lets a test hold a turn open.
 *
 * The real round trip chains six requests and can take seconds, which is the whole reason the
 * typing indicator exists - so the tests need to observe the widget *during* a turn, not only
 * after one. Each call hands back its own subject the test can resolve or fail when it likes.
 */
@Injectable()
class FakeChatService {
  readonly sent: string[] = [];
  private readonly pending: Subject<ChatMessage>[] = [];
  private readonly history: ChatMessage[] = [];

  handleUserMessage(text: string): Observable<ChatMessage> {
    this.sent.push(text);
    const turn = new Subject<ChatMessage>();
    this.pending.push(turn);
    return turn.asObservable();
  }

  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  /** The turn succeeds, the way the real service records both halves of it. */
  respondWith(text: string): void {
    const userText = this.sent[this.sent.length - 1];
    const assistant: ChatMessage = { role: 'assistant', text, timestamp: 2 };
    this.history.push({ role: 'user', text: userText, timestamp: 1 }, assistant);
    const turn = this.pending[this.pending.length - 1];
    turn.next(assistant);
    turn.complete();
  }

  /** Something the contract does not cover: the network, CORS, an unexpected 500. */
  failUnexpectedly(): void {
    this.pending[this.pending.length - 1].error(new Error('net::ERR_FAILED'));
  }
}

describe('ChatWidgetComponent', () => {
  let component: ChatWidgetComponent;
  let fixture: ComponentFixture<ChatWidgetComponent>;
  let chat: FakeChatService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatWidgetComponent],
      providers: [FakeChatService, { provide: ChatService, useExisting: FakeChatService }],
    }).compileComponents();

    chat = TestBed.inject(FakeChatService);
    fixture = TestBed.createComponent(ChatWidgetComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  function el(testid: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-testid="${testid}"]`);
  }

  function bubbles(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('[data-testid="chat-bubble"]'));
  }

  function openPanel(): void {
    el('chat-launcher')?.click();
    fixture.detectChanges();
  }

  function type(text: string): void {
    const input = el('chat-input') as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function send(text: string): void {
    type(text);
    fixture.nativeElement.querySelector('form')?.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
  }

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('opening and closing', () => {
    it('shows only the launcher until it is opened', () => {
      expect(el('chat-launcher')).toBeTruthy();
      expect(el('chat-panel')).toBeNull();
    });

    it('opens the panel when the launcher is clicked', () => {
      openPanel();
      expect(el('chat-panel')).toBeTruthy();
      expect(el('chat-launcher')).toBeNull();
    });
  });

  describe('the empty state', () => {
    it('shows before any message has been sent', () => {
      openPanel();
      expect(el('chat-empty-state')).toBeTruthy();
      expect(bubbles()).toHaveLength(0);
    });

    it('goes away once there is a message', () => {
      openPanel();
      send('25k tak boys hostel');
      expect(el('chat-empty-state')).toBeNull();
    });
  });

  describe('sending a message', () => {
    it('renders the user bubble immediately, then the assistant reply', () => {
      openPanel();
      send('25k tak boys hostel');

      // The person's own words are on screen before the search has come back.
      expect(bubbles()).toHaveLength(1);
      expect(bubbles()[0].textContent).toContain('25k tak boys hostel');
      expect(bubbles()[0].dataset['role']).toBe('user');

      chat.respondWith('Al-Madina Boys Hostel — Rs. 23,000/month');
      fixture.detectChanges();

      expect(bubbles()).toHaveLength(2);
      expect(bubbles()[1].dataset['role']).toBe('assistant');
      expect(bubbles()[1].textContent).toContain('Al-Madina');
    });

    it('passes the typed text through to the orchestrator', () => {
      openPanel();
      send('mere nazdeek hostel');
      expect(chat.sent).toEqual(['mere nazdeek hostel']);
    });

    it('clears the composer so the message is not sent twice', () => {
      openPanel();
      send('pehla sawaal');
      expect((el('chat-input') as HTMLInputElement).value).toBe('');
    });

    it('ignores an empty or whitespace-only message', () => {
      openPanel();
      send('   ');
      expect(chat.sent).toHaveLength(0);
      expect(bubbles()).toHaveLength(0);
    });
  });

  describe('the typing indicator', () => {
    it('shows for the whole round trip and clears when it returns', () => {
      openPanel();
      send('25k tak boys hostel');

      expect(el('chat-typing')).toBeTruthy();

      chat.respondWith('yeh raha');
      fixture.detectChanges();

      expect(el('chat-typing')).toBeNull();
    });

    it('clears even when the turn fails unexpectedly', () => {
      openPanel();
      send('25k tak boys hostel');
      chat.failUnexpectedly();
      fixture.detectChanges();

      // Never stuck spinning: `finalize` runs on the error path too.
      expect(el('chat-typing')).toBeNull();
    });

    it('does not show the empty state while a first turn is in flight', () => {
      openPanel();
      send('25k tak boys hostel');
      expect(el('chat-empty-state')).toBeNull();
    });
  });

  describe('the unexpected-failure safety net', () => {
    it('shows a generic message rather than crashing', () => {
      openPanel();
      send('25k tak boys hostel');
      chat.failUnexpectedly();
      fixture.detectChanges();

      expect(bubbles()).toHaveLength(2);
      expect(bubbles()[1].textContent).toContain(UNEXPECTED_ERROR_TEXT);
    });

    it('offers a retry button only after a failure', () => {
      openPanel();
      send('25k tak boys hostel');
      expect(el('chat-retry')).toBeNull();

      chat.failUnexpectedly();
      fixture.detectChanges();
      expect(el('chat-retry')).toBeTruthy();
    });

    it('resends the same text when retry is clicked', () => {
      openPanel();
      send('25k tak boys hostel');
      chat.failUnexpectedly();
      fixture.detectChanges();

      (el('chat-retry-button')?.querySelector('button') as HTMLButtonElement).click();
      fixture.detectChanges();

      expect(chat.sent).toEqual(['25k tak boys hostel', '25k tak boys hostel']);
    });

    it('does not repeat the person’s message on retry, and drops the failure notice', () => {
      openPanel();
      send('25k tak boys hostel');
      chat.failUnexpectedly();
      fixture.detectChanges();

      (el('chat-retry-button')?.querySelector('button') as HTMLButtonElement).click();
      fixture.detectChanges();

      // Back to just the one user bubble, with the search running again.
      expect(bubbles()).toHaveLength(1);
      expect(bubbles()[0].dataset['role']).toBe('user');
      expect(el('chat-typing')).toBeTruthy();
      expect(el('chat-retry')).toBeNull();
    });

    it('recovers fully when the retry succeeds', () => {
      openPanel();
      send('25k tak boys hostel');
      chat.failUnexpectedly();
      fixture.detectChanges();

      (el('chat-retry-button')?.querySelector('button') as HTMLButtonElement).click();
      fixture.detectChanges();
      chat.respondWith('Al-Madina Boys Hostel');
      fixture.detectChanges();

      expect(bubbles()).toHaveLength(2);
      expect(bubbles()[1].textContent).toContain('Al-Madina');
      expect(el('chat-retry')).toBeNull();
      expect(el('chat-typing')).toBeNull();
    });
  });
});
