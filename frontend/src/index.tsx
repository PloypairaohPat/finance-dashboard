import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App";
import "./index.css";
import { scrubSentryEvent } from "./lib/sentryScrub";

const clerkPubKey = process.env.REACT_APP_CLERK_PUBLISHABLE_KEY!;

const sentryDsn = process.env.REACT_APP_SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    sendDefaultPii: false,
    // Explicit scrubbing, not reliance on SDK defaults — mirrors the backend.
    beforeSend(event) {
      return scrubSentryEvent(event);
    },
  });
}

function ErrorFallback() {
  return (
    <div style={{ padding: 40, textAlign: "center", color: "#f0ede8", background: "#0a0a0a", minHeight: "100vh" }}>
      <h1 style={{ marginBottom: 12 }}>Something went wrong</h1>
      <p style={{ marginBottom: 24, opacity: 0.7 }}>
        The app hit an unexpected error. Reloading usually fixes it.
      </p>
      <button
        onClick={() => window.location.reload()}
        style={{
          padding: "10px 20px",
          borderRadius: 8,
          border: "none",
          background: "#f0ede8",
          color: "#0a0a0a",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Reload
      </button>
    </div>
  );
}

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);

root.render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
      <ClerkProvider publishableKey={clerkPubKey}>
        <App />
      </ClerkProvider>
    </Sentry.ErrorBoundary>
  </React.StrictMode>
);
