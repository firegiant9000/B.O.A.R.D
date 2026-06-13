import { ScrollViewStyleReset } from "expo-router/html";
import { type PropsWithChildren } from "react";

/**
 * Web-only HTML document wrapper (Month 2, Phase 5 — PWA).
 *
 * expo-router renders every web page inside this shell on the server, so it is the
 * single place to inject document-level <head> tags. We use it to:
 *   - declare the language (`lang="en"`) — a Lighthouse a11y requirement;
 *   - link the web app manifest + theme color so the app is installable;
 *   - add the apple-* meta tags so iOS Add-to-Home-Screen runs standalone
 *     (iOS Safari ignores `beforeinstallprompt`, so this is its install path);
 *   - register the hand-rolled service worker (`/sw.js`) after load.
 *
 * This file has no effect on native — it is never bundled into the iOS/Android app.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover"
        />

        {/* PWA: installability */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#2563eb" />
        <meta
          name="description"
          content="Real-time collaborative whiteboard for drawing, notes, and study sessions."
        />

        {/* iOS standalone (Add to Home Screen) */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="BOARD" />
        <link rel="apple-touch-icon" href="/icons/icon-1024.png" />
        <link rel="icon" href="/icons/favicon-48.png" sizes="48x48" />

        {/*
         * Disable body scrolling on web so the canvas/app owns the scroll, matching
         * native behaviour. Without this the document scrolls instead of the views.
         */}
        <ScrollViewStyleReset />

        {/* Register the service worker once the page has loaded. */}
        <script dangerouslySetInnerHTML={{ __html: sw }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

const sw = `
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function (err) {
      console.warn('Service worker registration failed:', err);
    });
  });
}
`;
