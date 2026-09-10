import { InjectionToken, Provider } from '@angular/core';

/**
 * Where the RoomRaah API lives, including its version prefix - for example
 * `http://52.72.119.254:8080/api/v1`.
 *
 * An injection token rather than an `environment.ts` import, because a library has no
 * environment of its own: the application that consumes it does, and this is how it says so.
 */
export const CHAT_API_BASE_URL = new InjectionToken<string>('CHAT_API_BASE_URL');

/** Everything the assistant needs from the host application, in one call. */
export function provideRoomRaahChat(apiBaseUrl: string): Provider[] {
  return [{ provide: CHAT_API_BASE_URL, useValue: apiBaseUrl }];
}
