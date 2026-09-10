import { provideHttpClient } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { DemoComponent } from './demo/demo.component';
import { provideRoomRaahChat } from './lib/chat-config';

/**
 * The API this demo talks to. A host application would read its own environment here; the
 * point of `provideRoomRaahChat` is that the package never has an opinion about the address.
 */
const API_BASE_URL = 'http://52.72.119.254:8080/api/v1';

bootstrapApplication(DemoComponent, {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    provideRoomRaahChat(API_BASE_URL),
  ],
}).catch((error) => console.error(error));
